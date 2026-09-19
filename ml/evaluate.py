"""Evaluates model performance, probability calibration, and simulated trading edge against Polymarket odds.

Includes window-segmented evaluation (by secondsRemaining) to address the 'Titik Rawan' vulnerability:
distinguishing true early-window predictive alpha from late-window market consensus mirroring.
"""

import argparse
from pathlib import Path
from typing import Dict, List, Optional

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score
import torch

from dataset import load_dataset, split_by_market_window
from models import PolymarketMLP


# Standard 5-minute market window slices (300 seconds total)
DEFAULT_TIME_BUCKETS = [
    {"name": "240–300s (Early Window)", "min_sec": 240, "max_sec": float("inf"), "is_early": True, "is_late": False},
    {"name": "180–240s (Mid-Early)",    "min_sec": 180, "max_sec": 240,          "is_early": False, "is_late": False},
    {"name": "120–180s (Mid Window)",   "min_sec": 120, "max_sec": 180,          "is_early": False, "is_late": False},
    {"name": " 60–120s (Mid-Late)",     "min_sec": 60,  "max_sec": 120,          "is_early": False, "is_late": False},
    {"name": "  0–60s  (Late Window)",   "min_sec": 0,   "max_sec": 60,           "is_early": False, "is_late": True},
]

# Explicit comparison between early and late window phases
EARLY_LATE_COMPARISON_BUCKETS = [
    {"name": "240–300s (Early Window)", "min_sec": 240, "max_sec": float("inf"), "is_early": True, "is_late": False},
    {"name": "  0–60s  (Late Window)",   "min_sec": 0,   "max_sec": 60,           "is_early": False, "is_late": True},
]


def parse_bucket_string(bucket_str: str) -> List[Dict]:
    """Parses a comma-separated bucket string (e.g. '0-60,240-300' or '0-60,60-120,...')."""
    buckets = []
    parts = [p.strip() for p in bucket_str.split(",") if p.strip()]
    for part in parts:
        tokens = part.split("-")
        if len(tokens) != 2:
            raise ValueError(
                f"Invalid bucket range '{part}'. Expected format 'min-max' (e.g. 0-60 or 240-300)."
            )
        min_s = float(tokens[0].strip())
        max_s = float(tokens[1].strip())
        name = f"{int(min_s):>3d}–{int(max_s):>3d}s"
        if min_s >= 240:
            name += " (Early Window)"
        elif max_s <= 60:
            name += " (Late Window)"
        buckets.append({
            "name": name,
            "min_sec": min_s,
            "max_sec": float("inf") if max_s >= 300 else max_s,
            "is_early": min_s >= 240,
            "is_late": max_s <= 60,
        })
    return buckets


def evaluate_trading_edge(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    pm_prob_up: np.ndarray,
    edge_threshold: float = 0.05,
    verbose: bool = True,
) -> dict:
    """Simulates trading outcomes when model probability diverges from Polymarket implied odds."""
    n_samples = len(y_true)
    bets = []

    for i in range(n_samples):
        model_prob = y_prob[i]
        market_prob = pm_prob_up[i]
        actual = y_true[i]

        # Edge exists if model is significantly more bullish or bearish than market
        if model_prob > market_prob + edge_threshold:
            # Bet UP: cost is market_prob, payoff is 1.0 if actual==1 else 0.0
            pnl = (1.0 - market_prob) if actual == 1 else -market_prob
            bets.append({"side": "UP", "won": actual == 1, "pnl": pnl})
        elif model_prob < market_prob - edge_threshold:
            # Bet DOWN: cost is (1.0 - market_prob), payoff is 1.0 if actual==0 else 0.0
            down_cost = 1.0 - market_prob
            pnl = (1.0 - down_cost) if actual == 0 else -down_cost
            bets.append({"side": "DOWN", "won": actual == 0, "pnl": pnl})

    if not bets:
        if verbose:
            print(f"No trading signals triggered with edge threshold {edge_threshold:.1%}")
        return {
            "total_bets": 0,
            "win_rate": 0.0,
            "total_pnl": 0.0,
            "roi": 0.0,
            "n_samples": n_samples,
            "signal_rate": 0.0,
        }

    total_bets = len(bets)
    wins = sum(1 for b in bets if b["won"])
    win_rate = wins / total_bets
    total_pnl = sum(b["pnl"] for b in bets)
    total_capital_risked = total_bets * 0.50  # average ~0.50 risk per bet
    roi = total_pnl / max(0.01, total_capital_risked)

    if verbose:
        print(f"\n--- Simulated Trading Edge Evaluation (threshold: {edge_threshold:.1%}) ---")
        print(f"  Total Signals Triggered: {total_bets} / {n_samples} ({total_bets/max(1, n_samples)*100:.1f}%)")
        print(f"  Simulated Win Rate:      {win_rate*100:.2f}% ({wins}/{total_bets})")
        print(f"  Net Simulated PnL:       {total_pnl:+.2f} units")
        print(f"  Simulated ROI:           {roi*100:+.2f}%")

    return {
        "total_bets": total_bets,
        "win_rate": win_rate,
        "total_pnl": total_pnl,
        "roi": roi,
        "n_samples": n_samples,
        "signal_rate": total_bets / max(1, n_samples),
    }


def compute_slice_metrics(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    pm_prob: np.ndarray,
    edge_threshold: float = 0.05,
) -> Dict:
    """Computes comparative ML classification, calibration, and trading metrics for a data slice."""
    n = len(y_true)
    if n == 0:
        return {
            "samples": 0,
            "model_acc": float("nan"),
            "market_acc": float("nan"),
            "acc_delta": float("nan"),
            "model_brier": float("nan"),
            "market_brier": float("nan"),
            "brier_delta": float("nan"),
            "brier_skill_score": float("nan"),
            "model_auc": float("nan"),
            "market_auc": float("nan"),
            "signals": 0,
            "win_rate": float("nan"),
            "total_pnl": 0.0,
            "roi": float("nan"),
        }

    y_pred = (y_prob >= 0.5).astype(int)
    market_pred = (pm_prob >= 0.5).astype(int)

    model_acc = float(accuracy_score(y_true, y_pred))
    market_acc = float(accuracy_score(y_true, market_pred))
    acc_delta = model_acc - market_acc

    model_brier = float(brier_score_loss(y_true, y_prob))
    market_brier = float(brier_score_loss(y_true, pm_prob))
    brier_delta = market_brier - model_brier  # > 0 means model has lower error than market
    bss = (1.0 - (model_brier / market_brier)) * 100.0 if market_brier > 1e-6 else 0.0

    has_both = len(np.unique(y_true)) > 1
    model_auc = float(roc_auc_score(y_true, y_prob)) if has_both else 0.5
    market_auc = float(roc_auc_score(y_true, pm_prob)) if has_both else 0.5

    edge_res = evaluate_trading_edge(y_true, y_prob, pm_prob, edge_threshold=edge_threshold, verbose=False)

    return {
        "samples": n,
        "model_acc": model_acc,
        "market_acc": market_acc,
        "acc_delta": acc_delta,
        "model_brier": model_brier,
        "market_brier": market_brier,
        "brier_delta": brier_delta,
        "brier_skill_score": bss,
        "model_auc": model_auc,
        "market_auc": market_auc,
        "signals": edge_res["total_bets"],
        "win_rate": edge_res["win_rate"],
        "total_pnl": edge_res["total_pnl"],
        "roi": edge_res["roi"],
    }


def evaluate_by_seconds_remaining(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    pm_prob_up: np.ndarray,
    seconds_remaining: np.ndarray,
    buckets: Optional[List[Dict]] = None,
    edge_threshold: float = 0.05,
    print_report: bool = True,
) -> Dict:
    """Evaluates model performance and trading edge segmented by remaining window seconds.

    Addresses the 'Titik Rawan' vulnerability: Polymarket implied odds (pmImpliedProbUp)
    and orderbook imbalances converge to actual outcomes as secondsRemaining approaches 0.
    Segmenting performance by time window allows distinguishing true early predictive alpha
    from late-window market consensus mirroring.
    """
    if buckets is None:
        buckets = DEFAULT_TIME_BUCKETS

    y_true = np.asarray(y_true)
    y_prob = np.asarray(y_prob)
    pm_prob_up = np.asarray(pm_prob_up)
    sec = np.asarray(seconds_remaining)

    total_samples = len(y_true)
    bucket_results = []

    for b in buckets:
        min_s = b["min_sec"]
        max_s = b["max_sec"]
        if max_s == float("inf"):
            mask = sec >= min_s
        else:
            mask = (sec >= min_s) & (sec < max_s)

        sub_y = y_true[mask]
        sub_prob = y_prob[mask]
        sub_pm = pm_prob_up[mask]

        metrics = compute_slice_metrics(sub_y, sub_prob, sub_pm, edge_threshold=edge_threshold)
        metrics["name"] = b["name"]
        metrics["min_sec"] = min_s
        metrics["max_sec"] = max_s
        metrics["is_early"] = b.get("is_early", min_s >= 240)
        metrics["is_late"] = b.get("is_late", max_s <= 60)
        metrics["pct_of_total"] = (metrics["samples"] / max(1, total_samples)) * 100.0
        bucket_results.append(metrics)

    overall_metrics = compute_slice_metrics(y_true, y_prob, pm_prob_up, edge_threshold=edge_threshold)
    overall_metrics["name"] = "OVERALL / FULL WINDOW"
    overall_metrics["pct_of_total"] = 100.0

    report = {
        "buckets": bucket_results,
        "overall": overall_metrics,
        "edge_threshold": edge_threshold,
    }

    if print_report:
        _print_segmented_report(report)

    return report


def _print_segmented_report(report: Dict) -> None:
    """Renders formatted ASCII table and diagnostic summary for time-segmented evaluation."""
    buckets = report["buckets"]
    overall = report["overall"]

    sep_double = "=" * 122
    sep_single = "-" * 122

    print(f"\n{sep_double}")
    print(f"{'EVALUATION BY SECONDS REMAINING (WINDOW SLICE ANALYSIS)':^122}")
    print(f"{'[Titik Rawan Assessment: Early Window Alpha vs Late Window Market Convergence]':^122}")
    print(f"{sep_double}")
    print(
        f"{'Slice / Window':<25} "
        f"{'Samples':>7} "
        f"{'Model Acc':>10} "
        f"{'Market Acc':>11} "
        f"{'Δ Acc':>8} "
        f"{'Model BS':>9} "
        f"{'Market BS':>10} "
        f"{'BSS (%)':>8} "
        f"{'Signals':>8} "
        f"{'Win Rate':>9} "
        f"{'Net PnL':>8} "
        f"{'ROI (%)':>8}"
    )
    print(sep_single)

    for b in buckets:
        n = b["samples"]
        if n == 0:
            print(
                f"{b['name']:<25} "
                f"{0:>7d} "
                f"{'N/A':>10} "
                f"{'N/A':>11} "
                f"{'N/A':>8} "
                f"{'N/A':>9} "
                f"{'N/A':>10} "
                f"{'N/A':>8} "
                f"{0:>8d} "
                f"{'N/A':>9} "
                f"{'0.00':>8} "
                f"{'N/A':>8}"
            )
            continue

        acc_str = f"{b['model_acc']*100:.1f}%"
        mkt_acc_str = f"{b['market_acc']*100:.1f}%"
        delta_acc_str = f"{b['acc_delta']*100:+.1f}%"
        bs_str = f"{b['model_brier']:.4f}"
        mkt_bs_str = f"{b['market_brier']:.4f}"
        bss_str = f"{b['brier_skill_score']:+.1f}%"
        sig_str = f"{b['signals']}"
        win_str = f"{b['win_rate']*100:.1f}%" if b["signals"] > 0 else "0.0%"
        pnl_str = f"{b['total_pnl']:+.2f}"
        roi_str = f"{b['roi']*100:+.1f}%" if b["signals"] > 0 else "0.0%"

        print(
            f"{b['name']:<25} "
            f"{n:>7d} "
            f"{acc_str:>10} "
            f"{mkt_acc_str:>11} "
            f"{delta_acc_str:>8} "
            f"{bs_str:>9} "
            f"{mkt_bs_str:>10} "
            f"{bss_str:>8} "
            f"{sig_str:>8} "
            f"{win_str:>9} "
            f"{pnl_str:>8} "
            f"{roi_str:>8}"
        )

    print(sep_single)

    # Overall row
    n_tot = overall["samples"]
    acc_tot = f"{overall['model_acc']*100:.1f}%"
    mkt_acc_tot = f"{overall['market_acc']*100:.1f}%"
    delta_acc_tot = f"{overall['acc_delta']*100:+.1f}%"
    bs_tot = f"{overall['model_brier']:.4f}"
    mkt_bs_tot = f"{overall['market_brier']:.4f}"
    bss_tot = f"{overall['brier_skill_score']:+.1f}%"
    sig_tot = f"{overall['signals']}"
    win_tot = f"{overall['win_rate']*100:.1f}%" if overall["signals"] > 0 else "0.0%"
    pnl_tot = f"{overall['total_pnl']:+.2f}"
    roi_tot = f"{overall['roi']*100:+.1f}%" if overall["signals"] > 0 else "0.0%"

    print(
        f"{overall['name']:<25} "
        f"{n_tot:>7d} "
        f"{acc_tot:>10} "
        f"{mkt_acc_tot:>11} "
        f"{delta_acc_tot:>8} "
        f"{bs_tot:>9} "
        f"{mkt_bs_tot:>10} "
        f"{bss_tot:>8} "
        f"{sig_tot:>8} "
        f"{win_tot:>9} "
        f"{pnl_tot:>8} "
        f"{roi_tot:>8}"
    )
    print(sep_double)

    # Diagnostic Summary ("Titik Rawan" Analysis)
    early_b = next((b for b in buckets if b["is_early"] and b["samples"] > 0), None)
    late_b = next((b for b in reversed(buckets) if b["is_late"] and b["samples"] > 0), None)

    print("\n🔍 Titik Rawan Diagnostic Summary:")
    print("  • Context:")
    print("    Features 'pmImpliedProbUp' and 'upOrderBookImbalance' are derived from Polymarket odds.")
    print("    Near window close (low secondsRemaining), Polymarket prices naturally converge to the true outcome.")
    print("    Evaluating early window (240–300s) isolates genuine alpha from late-window market mirroring.")

    if late_b:
        print(f"\n  • Late Window ({late_b['name'].strip()}):")
        print(f"    - Market Benchmark Accuracy: {late_b['market_acc']*100:.1f}% (Outcome largely resolved)")
        print(f"    - Model Accuracy:            {late_b['model_acc']*100:.1f}% (Δ vs Market: {late_b['acc_delta']*100:+.1f}%)")
        print(f"    - Model Brier Score:         {late_b['model_brier']:.4f} (Market Brier: {late_b['market_brier']:.4f})")
    else:
        print("\n  • Late Window: No samples recorded in test range.")

    if early_b:
        print(f"\n  • Early Window ({early_b['name'].strip()}):")
        print(f"    - Market Benchmark Accuracy: {early_b['market_acc']*100:.1f}% (High uncertainty / 50-50 odds)")
        print(f"    - Model Accuracy:            {early_b['model_acc']*100:.1f}% (Δ vs Market: {early_b['acc_delta']*100:+.1f}%)")
        print(f"    - Brier Skill Score (BSS):   {early_b['brier_skill_score']:+.1f}% improvement over market odds")
        sig_info = (
            f"{early_b['signals']} signals, Win Rate: {early_b['win_rate']*100:.1f}%, "
            f"Net PnL: {early_b['total_pnl']:+.2f} (ROI: {early_b['roi']*100:+.1f}%)"
            if early_b["signals"] > 0 else "0 signals triggered"
        )
        print(f"    - Simulated Trading Edge:    {sig_info}")

        # Verdict
        if early_b["acc_delta"] > 0 and early_b["roi"] > 0:
            print("\n  • Assessment: [GENUINE ALPHA CONFIRMED]")
            print("    The model outperforms market odds in the early window when uncertainty is high.")
            print(f"    Value-add: {early_b['acc_delta']*100:+.1f}% accuracy advantage and {early_b['roi']*100:+.1f}% ROI.")
        elif early_b["acc_delta"] > 0 and early_b["signals"] == 0:
            print("\n  • Assessment: [CALIBRATED BUT CONSERVATIVE]")
            print("    Model accuracy exceeds market in early window, but no bets exceeded the edge threshold.")
        elif early_b["acc_delta"] <= 0 or (early_b["signals"] > 0 and early_b["roi"] <= 0):
            print("\n  • Assessment: [TITIK RAWAN DETECTED - LATE CONVERGENCE RISK]")
            print("    The model fails to generate positive edge in early windows when market odds are ~50%.")
            print("    Its overall accuracy is primarily an artifact of late-window market consensus.")
            print("    Recommendation: Train with '--exclude-pm-features' or add stronger exogenous BTC signals.")
    else:
        print("\n  • Early Window: No samples recorded in test range.")


def run_evaluation(
    csv_path: str = "data/dataset/dataset.csv",
    model_type: str = "nn",
    edge_threshold: float = 0.05,
    buckets: Optional[List[Dict]] = None,
    compare_early_late: bool = False,
    test_only: bool = False,
) -> Dict:
    """Executes full evaluation on dataset and displays time-segmented performance."""
    df = load_dataset(csv_path)

    if test_only:
        _, _, df_test = split_by_market_window(df)
        eval_df = df_test if len(df_test) > 0 else df
        print(f"Evaluating exclusively on test split ({len(eval_df)} samples, {len(eval_df['slug'].unique())} market windows)...")
    else:
        eval_df = df

    ckpt_dir = Path("ml/checkpoints")
    scaler_path = ckpt_dir / "scaler.joblib"
    if not scaler_path.exists():
        raise FileNotFoundError("Scaler not found. Train baseline or NN model first.")

    scaler = joblib.load(scaler_path)

    if model_type == "nn":
        model_path = ckpt_dir / "best_mlp.pt"
        if not model_path.exists():
            raise FileNotFoundError(f"Model {model_path} not found. Run 'python3 ml/train_nn.py' first.")
        checkpoint = torch.load(model_path, map_location="cpu", weights_only=True)
        feature_cols = checkpoint["feature_cols"]
        model = PolymarketMLP(
            input_dim=checkpoint["input_dim"],
            hidden_dim=checkpoint["hidden_dim"],
        )
        model.load_state_dict(checkpoint["model_state"])
        model.eval()

        X = eval_df[feature_cols].values.astype(np.float32)
        X_scaled = scaler.transform(X)
        with torch.no_grad():
            y_prob = model.predict_proba(torch.tensor(X_scaled, dtype=torch.float32)).numpy().flatten()

    elif model_type == "lgbm":
        model_path = ckpt_dir / "baseline_lgbm.txt"
        if not model_path.exists():
            raise FileNotFoundError(f"Model {model_path} not found. Run 'python3 ml/train_baseline.py' first.")
        gbm = lgb.Booster(model_file=str(model_path))
        feature_cols = [c for c in eval_df.columns if c not in [
            "timestampMs", "timestampUtc", "slug", "conditionId", "sequence",
            "target", "label", "windowLabelRule", "windowStartPrice", "windowEndPrice"
        ]]
        X = eval_df[feature_cols].values.astype(np.float32)
        X_scaled = scaler.transform(X)
        y_prob = gbm.predict(X_scaled)

    else:
        # Logistic Regression
        model_path = ckpt_dir / "baseline_lr.joblib"
        if not model_path.exists():
            raise FileNotFoundError(f"Model {model_path} not found. Run 'python3 ml/train_baseline.py' first.")
        model = joblib.load(model_path)
        feature_cols = [c for c in eval_df.columns if c not in [
            "timestampMs", "timestampUtc", "slug", "conditionId", "sequence",
            "target", "label", "windowLabelRule", "windowStartPrice", "windowEndPrice"
        ]]
        X = eval_df[feature_cols].values.astype(np.float32)
        X_scaled = scaler.transform(X)
        y_prob = model.predict_proba(X_scaled)[:, 1]

    y_true = eval_df["target"].values
    pm_prob_up = eval_df["pmImpliedProbUp"].values if "pmImpliedProbUp" in eval_df.columns else np.full_like(y_true, 0.5)
    seconds_remaining = eval_df["secondsRemaining"].values if "secondsRemaining" in eval_df.columns else np.zeros_like(y_true)

    # Determine evaluation buckets
    if compare_early_late:
        eval_buckets = EARLY_LATE_COMPARISON_BUCKETS
    elif buckets:
        eval_buckets = buckets
    else:
        eval_buckets = DEFAULT_TIME_BUCKETS

    # Run overall trading edge summary
    evaluate_trading_edge(y_true, y_prob, pm_prob_up, edge_threshold=edge_threshold, verbose=True)

    # Run time-segmented evaluation
    return evaluate_by_seconds_remaining(
        y_true=y_true,
        y_prob=y_prob,
        pm_prob_up=pm_prob_up,
        seconds_remaining=seconds_remaining,
        buckets=eval_buckets,
        edge_threshold=edge_threshold,
        print_report=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Evaluate trading edge against Polymarket prices, with time-segmented window analysis."
    )
    parser.add_argument("--csv", type=str, default="data/dataset/dataset.csv")
    parser.add_argument("--model", type=str, default="nn", choices=["nn", "lr", "lgbm"])
    parser.add_argument("--edge", type=float, default=0.05, help="Minimum probability edge (e.g. 0.05 = 5%%)")
    parser.add_argument(
        "--buckets",
        type=str,
        default=None,
        help="Custom bucket intervals e.g. '0-60,60-120,120-180,180-240,240-300' or '0-60,240-300'",
    )
    parser.add_argument(
        "--compare-early-late",
        action="store_true",
        help="Compare only early window (240–300s) vs late window (0–60s)",
    )
    parser.add_argument(
        "--test-only",
        action="store_true",
        help="Evaluate strictly on the chronological test split instead of the entire dataset",
    )
    args = parser.parse_args()

    parsed_buckets = parse_bucket_string(args.buckets) if args.buckets else None

    run_evaluation(
        csv_path=args.csv,
        model_type=args.model,
        edge_threshold=args.edge,
        buckets=parsed_buckets,
        compare_early_late=args.compare_early_late,
        test_only=args.test_only,
    )
