"""Unit tests for time-segmented evaluation, trading edge simulation, and Titik Rawan detection."""

import sys
import unittest
from pathlib import Path
import numpy as np
import pandas as pd

# Add ml/ directory to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ml"))

from dataset import PM_MARKET_FEATURE_COLS, prepare_ml_data
from evaluate import (
    DEFAULT_TIME_BUCKETS,
    EARLY_LATE_COMPARISON_BUCKETS,
    compute_slice_metrics,
    evaluate_by_seconds_remaining,
    evaluate_trading_edge,
    parse_bucket_string,
)


class TestEvaluation(unittest.TestCase):
    def test_parse_bucket_string_valid(self):
        buckets = parse_bucket_string("0-60, 240-300")
        self.assertEqual(len(buckets), 2)
        self.assertEqual(buckets[0]["min_sec"], 0)
        self.assertEqual(buckets[0]["max_sec"], 60)
        self.assertTrue(buckets[0]["is_late"])
        self.assertFalse(buckets[0]["is_early"])

        self.assertEqual(buckets[1]["min_sec"], 240)
        self.assertEqual(buckets[1]["max_sec"], float("inf"))
        self.assertTrue(buckets[1]["is_early"])
        self.assertFalse(buckets[1]["is_late"])

    def test_parse_bucket_string_invalid(self):
        with self.assertRaises(ValueError):
            parse_bucket_string("0_60, invalid")

    def test_evaluate_trading_edge_win_and_loss(self):
        # Sample 0: Model 0.80, Market 0.50 -> Bet UP, actual=1 -> Won: payoff = 1 - 0.50 = +0.50
        # Sample 1: Model 0.20, Market 0.50 -> Bet DOWN, actual=1 -> Lost: down cost = 0.50, pnl = -0.50
        # Sample 2: Model 0.52, Market 0.50 -> Divergence 0.02 < 0.05 -> No signal
        y_true = np.array([1, 1, 1])
        y_prob = np.array([0.80, 0.20, 0.52])
        pm_prob = np.array([0.50, 0.50, 0.50])

        res = evaluate_trading_edge(y_true, y_prob, pm_prob, edge_threshold=0.05, verbose=False)
        self.assertEqual(res["total_bets"], 2)
        self.assertAlmostEqual(res["win_rate"], 0.50)
        self.assertAlmostEqual(res["total_pnl"], 0.0)
        self.assertAlmostEqual(res["roi"], 0.0)

    def test_compute_slice_metrics_accuracy_and_brier(self):
        y_true = np.array([1, 1, 0, 0])
        # Model is 100% accurate
        y_prob = np.array([0.9, 0.8, 0.1, 0.2])
        # Market is 50-50 unsure
        pm_prob = np.array([0.5, 0.5, 0.5, 0.5])

        metrics = compute_slice_metrics(y_true, y_prob, pm_prob, edge_threshold=0.05)
        self.assertEqual(metrics["samples"], 4)
        self.assertEqual(metrics["model_acc"], 1.0)
        self.assertEqual(metrics["market_acc"], 0.50)
        self.assertEqual(metrics["acc_delta"], 0.50)
        self.assertLess(metrics["model_brier"], metrics["market_brier"])
        self.assertGreater(metrics["brier_skill_score"], 0)

    def test_compute_slice_metrics_empty(self):
        metrics = compute_slice_metrics(np.array([]), np.array([]), np.array([]))
        self.assertEqual(metrics["samples"], 0)
        self.assertTrue(np.isnan(metrics["model_acc"]))
        self.assertTrue(np.isnan(metrics["market_acc"]))

    def test_titik_rawan_scenario_late_convergence_vs_early_alpha(self):
        """Simulates the exact Titik Rawan scenario described in the user prompt:

        - Late window (0-60s remaining): Polymarket prices have already converged (pmImplied=0.95/0.05).
          The model simply copies market price, achieving 90%+ accuracy without generating new alpha.
        - Early window (240-300s remaining): Market is at 0.50 (uncertain).
          A naive model has zero edge early on, but looks great overall if evaluated without segmentation.
        """
        n_early = 100
        n_late = 100

        # Late window: market already knows the outcome!
        y_late = np.random.binomial(1, 0.5, size=n_late)
        # Market is 95% accurate near expiry
        pm_late = np.where(y_late == 1, 0.95, 0.05)
        # Model simply mirrors market:
        y_prob_late = pm_late.copy()
        sec_late = np.random.uniform(5, 55, size=n_late)

        # Early window: market has no idea (pmImplied = 0.50)
        y_early = np.random.binomial(1, 0.5, size=n_early)
        pm_early = np.full(n_early, 0.50)
        # Naive model also has no edge early (random guess near 0.50)
        y_prob_early = np.full(n_early, 0.50)
        sec_early = np.random.uniform(245, 295, size=n_early)

        # Concatenate full dataset
        y_true = np.concatenate([y_early, y_late])
        y_prob = np.concatenate([y_prob_early, y_prob_late])
        pm_prob = np.concatenate([pm_early, pm_late])
        seconds = np.concatenate([sec_early, sec_late])

        report = evaluate_by_seconds_remaining(
            y_true, y_prob, pm_prob, seconds, buckets=EARLY_LATE_COMPARISON_BUCKETS, print_report=True
        )

        early_bucket = next(b for b in report["buckets"] if b["is_early"])
        late_bucket = next(b for b in report["buckets"] if b["is_late"])

        # Late window accuracy is ~100%
        self.assertGreaterEqual(late_bucket["model_acc"], 0.90)
        self.assertGreaterEqual(late_bucket["market_acc"], 0.90)
        # Early window: model has 0 advantage over market
        self.assertAlmostEqual(early_bucket["acc_delta"], 0.0, places=2)
        # Signals triggered in early window should be 0 because model doesn't deviate from market
        self.assertEqual(early_bucket["signals"], 0)

    def test_genuine_early_alpha_scenario(self):
        """Simulates a model with genuine early window alpha (beats market by 15% in 240-300s window)."""
        n = 100
        y_true = np.array([1] * 50 + [0] * 50)
        # Market in early window is ~0.50
        pm_prob = np.full(n, 0.50)
        # Model in early window is 65% accurate
        y_prob = np.array([0.65] * 35 + [0.35] * 15 + [0.35] * 35 + [0.65] * 15)
        seconds = np.full(n, 270.0)  # 270 seconds remaining (early window)

        report = evaluate_by_seconds_remaining(
            y_true, y_prob, pm_prob, seconds, buckets=EARLY_LATE_COMPARISON_BUCKETS, print_report=True
        )
        early_bucket = next(b for b in report["buckets"] if b["is_early"])
        self.assertGreater(early_bucket["model_acc"], early_bucket["market_acc"])
        self.assertGreater(early_bucket["acc_delta"], 0)
        self.assertGreater(early_bucket["roi"], 0)

    def test_exclude_pm_features_filtering(self):
        """Verifies that exclude_pm_features properly filters out PM_MARKET_FEATURE_COLS."""
        # Create a dummy dataframe with all features
        n_samples = 30
        data = {
            "slug": ["market-1"] * n_samples,
            "timestampMs": list(range(n_samples)),
            "target": [1, 0] * 15,
            "secondsRemaining": [150] * n_samples,
            "fractionElapsed": [0.5] * n_samples,
            "btcPrice": [90000.0] * n_samples,
            "btcReturn5s": [0.001] * n_samples,
            "btcReturn15s": [0.002] * n_samples,
            "btcReturn60s": [0.003] * n_samples,
            "btcReturn300s": [0.005] * n_samples,
            "btcVol5s": [0.0001] * n_samples,
            "btcVol15s": [0.0002] * n_samples,
            "btcVol60s": [0.0003] * n_samples,
            "btcSpread": [1.0] * n_samples,
            "btcMid": [90000.0] * n_samples,
            "pmImpliedProbUp": [0.55] * n_samples,
            "upOrderBookImbalance": [0.2] * n_samples,
            "downOrderBookImbalance": [-0.2] * n_samples,
        }
        for pm_col in PM_MARKET_FEATURE_COLS:
            if pm_col not in data:
                data[pm_col] = [0.5] * n_samples

        df = pd.DataFrame(data)
        csv_path = "/tmp/test_dummy_dataset.csv"
        df.to_csv(csv_path, index=False)

        # 1. With PM features
        res_with_pm = prepare_ml_data(csv_path=csv_path, exclude_pm_features=False)
        self.assertIn("pmImpliedProbUp", res_with_pm["feature_cols"])
        self.assertIn("upOrderBookImbalance", res_with_pm["feature_cols"])

        # 2. Excluded PM features
        res_no_pm = prepare_ml_data(csv_path=csv_path, exclude_pm_features=True)
        self.assertNotIn("pmImpliedProbUp", res_no_pm["feature_cols"])
        self.assertNotIn("upOrderBookImbalance", res_no_pm["feature_cols"])
        for col in PM_MARKET_FEATURE_COLS:
            self.assertNotIn(col, res_no_pm["feature_cols"])

    def test_end_to_end_train_baseline_and_evaluate(self):
        """Verifies train_baseline and run_evaluation execute cleanly end-to-end with time slices."""
        from train_baseline import train_baseline
        from evaluate import run_evaluation

        n_samples = 60
        slugs = ["window-1"] * 30 + ["window-2"] * 30
        data = {
            "slug": slugs,
            "timestampMs": list(range(n_samples)),
            "target": [1, 0] * 30,
            "secondsRemaining": [280, 250, 190, 140, 80, 20] * 10,
            "fractionElapsed": [0.1, 0.2, 0.4, 0.6, 0.8, 0.95] * 10,
            "btcPrice": [90000.0 + i * 10 for i in range(n_samples)],
            "btcReturn1s": [0.0001] * n_samples,
            "btcReturn5s": [0.001] * n_samples,
            "btcReturn15s": [0.002] * n_samples,
            "btcReturn60s": [0.003] * n_samples,
            "btcReturn300s": [0.005] * n_samples,
            "btcVol5s": [0.0001] * n_samples,
            "btcVol15s": [0.0002] * n_samples,
            "btcVol60s": [0.0003] * n_samples,
            "btcBid": [89999.0] * n_samples,
            "btcAsk": [90001.0] * n_samples,
            "btcSpread": [2.0] * n_samples,
            "btcMid": [90000.0] * n_samples,
            "btcVolumeDelta5s": [10.0] * n_samples,
            "btcBuySellRatio": [1.1] * n_samples,
            "btcNetVolume": [5.0] * n_samples,
            "chainlinkPrice": [90000.0] * n_samples,
            "chainlinkReturn5s": [0.0005] * n_samples,
            "chainlinkReturn15s": [0.0010] * n_samples,
            "chainlinkBinanceBasis": [0.5] * n_samples,
            "pmImpliedProbUp": [0.52] * n_samples,
            "upOrderBookImbalance": [0.2] * n_samples,
            "downOrderBookImbalance": [-0.2] * n_samples,
        }
        for pm_col in PM_MARKET_FEATURE_COLS:
            if pm_col not in data:
                data[pm_col] = [0.5] * n_samples

        df = pd.DataFrame(data)
        csv_path = "/tmp/test_end_to_end_dataset.csv"
        df.to_csv(csv_path, index=False)

        # Train baseline
        train_baseline(csv_path=csv_path, exclude_pm_features=False)

        # Evaluate LR
        report_lr = run_evaluation(csv_path=csv_path, model_type="lr", compare_early_late=True)
        self.assertEqual(len(report_lr["buckets"]), 2)
        self.assertEqual(report_lr["overall"]["samples"], n_samples)

        # Evaluate LGBM
        report_lgbm = run_evaluation(csv_path=csv_path, model_type="lgbm")
        self.assertEqual(len(report_lgbm["buckets"]), len(DEFAULT_TIME_BUCKETS))
        self.assertEqual(report_lgbm["overall"]["samples"], n_samples)


if __name__ == "__main__":
    unittest.main()
