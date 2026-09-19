"""Evaluates model performance, probability calibration, and simulated trading edge against Polymarket odds."""

import argparse
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import torch

from dataset import load_dataset
from models import PolymarketMLP


def evaluate_trading_edge(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    pm_prob_up: np.ndarray,
    edge_threshold: float = 0.05,
) -> dict:
    """Simulates trading outcomes when model probability diverges from Polymarket implied odds."""
    n_samples = len(y_true)
    bets = []  # +1 if won, -1 if lost

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
        print(f"No trading signals triggered with edge threshold {edge_threshold:.1%}")
        return {"total_bets": 0, "win_rate": 0.0, "total_pnl": 0.0, "roi": 0.0}

    total_bets = len(bets)
    wins = sum(1 for b in bets if b["won"])
    win_rate = wins / total_bets
    total_pnl = sum(b["pnl"] for b in bets)
    total_capital_risked = total_bets * 0.50  # average ~0.50 risk per bet
    roi = total_pnl / max(0.01, total_capital_risked)

    print(f"\n--- Simulated Trading Edge Evaluation (threshold: {edge_threshold:.1%}) ---")
    print(f"  Total Signals Triggered: {total_bets} / {n_samples} ({total_bets/n_samples*100:.1f}%)")
    print(f"  Simulated Win Rate:      {win_rate*100:.2f}% ({wins}/{total_bets})")
    print(f"  Net Simulated PnL:       {total_pnl:+.2f} units")
    print(f"  Simulated ROI:           {roi*100:+.2f}%")

    return {
        "total_bets": total_bets,
        "win_rate": win_rate,
        "total_pnl": total_pnl,
        "roi": roi,
    }


def run_evaluation(
    csv_path: str = "data/dataset/dataset.csv",
    model_type: str = "nn",
    edge_threshold: float = 0.05,
) -> None:
    df = load_dataset(csv_path)

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

        X = df[feature_cols].values.astype(np.float32)
        X_scaled = scaler.transform(X)
        with torch.no_grad():
            y_prob = model.predict_proba(torch.tensor(X_scaled, dtype=torch.float32)).numpy().flatten()
    else:
        # Logistic Regression or LightGBM
        model_path = ckpt_dir / "baseline_lr.joblib"
        if not model_path.exists():
            raise FileNotFoundError(f"Model {model_path} not found. Run 'python3 ml/train_baseline.py' first.")
        model = joblib.load(model_path)
        feature_cols = [c for c in df.columns if c not in [
            "timestampMs", "timestampUtc", "slug", "conditionId", "sequence",
            "target", "label", "windowLabelRule", "windowStartPrice", "windowEndPrice"
        ]]
        X = df[feature_cols].values.astype(np.float32)
        X_scaled = scaler.transform(X)
        y_prob = model.predict_proba(X_scaled)[:, 1]

    y_true = df["target"].values
    pm_prob_up = df["pmImpliedProbUp"].values if "pmImpliedProbUp" in df.columns else np.full_like(y_true, 0.5)

    evaluate_trading_edge(y_true, y_prob, pm_prob_up, edge_threshold=edge_threshold)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate trading edge against Polymarket prices.")
    parser.add_argument("--csv", type=str, default="data/dataset/dataset.csv")
    parser.add_argument("--model", type=str, default="nn", choices=["nn", "lr"])
    parser.add_argument("--edge", type=float, default=0.05, help="Minimum probability edge (e.g. 0.05 = 5%%)")
    args = parser.parse_args()

    run_evaluation(csv_path=args.csv, model_type=args.model, edge_threshold=args.edge)
