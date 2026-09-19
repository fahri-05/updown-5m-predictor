"""Real-time inference script: predicts outcome probability from feature input using the trained Neural Network."""

import argparse
import json
from pathlib import Path
from typing import Dict, Union

import joblib
import numpy as np
import torch

from models import PolymarketMLP


class PolymarketPredictor:
    """Loads trained checkpoint and scaler for fast single-sample or batch inference."""

    def __init__(
        self,
        checkpoint_path: str = "ml/checkpoints/best_mlp.pt",
        scaler_path: str = "ml/checkpoints/scaler.joblib",
    ):
        ckpt = Path(checkpoint_path)
        scl = Path(scaler_path)

        if not ckpt.exists():
            raise FileNotFoundError(f"Checkpoint '{checkpoint_path}' not found. Train with 'python3 ml/train_nn.py'.")
        if not scl.exists():
            raise FileNotFoundError(f"Scaler '{scaler_path}' not found.")

        self.scaler = joblib.load(scl)
        saved = torch.load(ckpt, map_location="cpu", weights_only=True)
        self.feature_cols = saved["feature_cols"]

        self.model = PolymarketMLP(
            input_dim=saved["input_dim"],
            hidden_dim=saved["hidden_dim"],
        )
        self.model.load_state_dict(saved["model_state"])
        self.model.eval()

    def predict(self, features: Dict[str, Union[float, int]]) -> Dict[str, float]:
        """Takes a dictionary of feature values and returns predicted probabilities and edge."""
        row = [float(features.get(col, 0.0)) for col in self.feature_cols]
        x = np.array([row], dtype=np.float32)
        x_scaled = self.scaler.transform(x)

        with torch.no_grad():
            prob_up = float(self.model.predict_proba(torch.tensor(x_scaled, dtype=torch.float32))[0, 0].item())

        prob_down = 1.0 - prob_up
        predicted_side = "UP" if prob_up >= 0.5 else "DOWN"
        confidence = max(prob_up, prob_down)

        pm_implied = float(features.get("pmImpliedProbUp", 0.5))
        edge = prob_up - pm_implied

        return {
            "predicted_side": predicted_side,
            "prob_up": round(prob_up, 4),
            "prob_down": round(prob_down, 4),
            "confidence": round(confidence, 4),
            "polymarket_implied_up": round(pm_implied, 4),
            "edge_up": round(edge, 4),
        }


def main():
    parser = argparse.ArgumentParser(description="Run Polymarket ML prediction on sample features.")
    parser.add_argument("--json", type=str, help="JSON string containing feature dictionary", default=None)
    args = parser.parse_args()

    predictor = PolymarketPredictor()

    sample_features = {
        "secondsRemaining": 120,
        "fractionElapsed": 0.6,
        "btcReturn5s": 0.0008,
        "btcReturn15s": 0.0015,
        "btcReturn60s": 0.0030,
        "upOrderBookImbalance": 0.35,
        "downOrderBookImbalance": -0.25,
        "pmImpliedProbUp": 0.55,
        "chainlinkBinanceBasis": 1.2,
    }

    if args.json:
        sample_features.update(json.loads(args.json))

    pred = predictor.predict(sample_features)
    print("\n--- Model Inference Result ---")
    print(f"  Predicted Side:  {pred['predicted_side']}")
    print(f"  P(UP):           {pred['prob_up']*100:.2f}%")
    print(f"  P(DOWN):         {pred['prob_down']*100:.2f}%")
    print(f"  Confidence:      {pred['confidence']*100:.2f}%")
    print(f"  Market Implied:  {pred['polymarket_implied_up']*100:.2f}%")
    print(f"  Estimated Edge:  {pred['edge_up']*100:+.2f}%")


if __name__ == "__main__":
    main()
