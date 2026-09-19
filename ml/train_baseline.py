"""Trains Baseline ML Models (LightGBM & Logistic Regression) as accuracy benchmarks."""

import argparse
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)

from dataset import prepare_ml_data


def evaluate_predictions(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    model_name: str,
    split_name: str,
) -> dict:
    """Computes standard ML classification metrics and Brier score."""
    y_pred = (y_prob >= 0.5).astype(int)

    acc = accuracy_score(y_true, y_pred)
    brier = brier_score_loss(y_true, y_prob)

    # ROC AUC requires at least one positive and one negative sample
    has_both_classes = len(np.unique(y_true)) > 1
    auc = roc_auc_score(y_true, y_prob) if has_both_classes else 0.5
    loss = log_loss(y_true, y_prob, labels=[0, 1])

    print(f"\n[{model_name}] Results on {split_name} set ({len(y_true)} samples):")
    print(f"  Accuracy:    {acc:.4f} ({acc*100:.1f}%)")
    print(f"  ROC-AUC:     {auc:.4f}")
    print(f"  Brier Score: {brier:.4f} (lower is better, random is 0.25)")
    print(f"  Log Loss:    {loss:.4f}")

    return {"accuracy": acc, "roc_auc": auc, "brier_score": brier, "log_loss": loss}


def train_baseline(csv_path: str = "data/dataset/dataset.csv") -> None:
    print(f"Loading data from {csv_path}...")
    data = prepare_ml_data(csv_path=csv_path, train_ratio=0.70, val_ratio=0.15)

    X_train, y_train = data["X_train"], data["y_train"]
    X_val, y_val = data["X_val"], data["y_val"]
    X_test, y_test = data["X_test"], data["y_test"]
    features = data["feature_cols"]

    print(f"Dataset split: Train={len(X_train)}, Val={len(X_val)}, Test={len(X_test)}")
    print(f"Total features: {len(features)}")
    print(f"Train UP ratio: {np.mean(y_train):.2%}")

    ckpt_dir = Path("ml/checkpoints")
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    # 1. Logistic Regression Baseline
    print("\n--- Training Logistic Regression Baseline ---")
    lr = LogisticRegression(C=0.1, max_iter=1000, random_state=42)
    lr.fit(X_train, y_train)

    if len(X_val) > 0:
        val_probs_lr = lr.predict_proba(X_val)[:, 1]
        evaluate_predictions(y_val, val_probs_lr, "Logistic Regression", "Validation")

    test_probs_lr = lr.predict_proba(X_test if len(X_test) > 0 else X_train)[:, 1]
    y_test_eval = y_test if len(X_test) > 0 else y_train
    evaluate_predictions(y_test_eval, test_probs_lr, "Logistic Regression", "Test" if len(X_test) > 0 else "Train")

    joblib.dump(lr, ckpt_dir / "baseline_lr.joblib")

    # 2. LightGBM Gradient Boosting Baseline
    print("\n--- Training LightGBM Baseline ---")
    lgb_train = lgb.Dataset(X_train, label=y_train)
    lgb_val = lgb.Dataset(X_val, label=y_val, reference=lgb_train) if len(X_val) > 0 else None

    params = {
        "objective": "binary",
        "metric": ["binary_logloss", "auc"],
        "boosting_type": "gbdt",
        "learning_rate": 0.03,
        "num_leaves": 31,
        "max_depth": 5,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "verbose": -1,
        "random_state": 42,
    }

    valid_sets = [lgb_train]
    if lgb_val:
        valid_sets.append(lgb_val)

    gbm = lgb.train(
        params,
        lgb_train,
        num_boost_round=150,
        valid_sets=valid_sets,
    )

    if len(X_val) > 0:
        val_probs_gbm = gbm.predict(X_val)
        evaluate_predictions(y_val, val_probs_gbm, "LightGBM", "Validation")

    test_probs_gbm = gbm.predict(X_test if len(X_test) > 0 else X_train)
    evaluate_predictions(y_test_eval, test_probs_gbm, "LightGBM", "Test" if len(X_test) > 0 else "Train")

    # Feature Importance
    print("\n--- Top 10 Most Important Features (LightGBM) ---")
    importance = gbm.feature_importance(importance_type="gain")
    sorted_idx = np.argsort(importance)[::-1]

    for rank, idx in enumerate(sorted_idx[:10], start=1):
        print(f"  {rank:2d}. {features[idx]:<25} (gain: {importance[idx]:.1f})")

    gbm.save_model(str(ckpt_dir / "baseline_lgbm.txt"))
    print(f"\nModels saved to {ckpt_dir}/")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train baseline models for Polymarket Up/Down 5m.")
    parser.add_argument(
        "--csv",
        type=str,
        default="data/dataset/dataset.csv",
        help="Path to labeled dataset CSV",
    )
    args = parser.parse_args()
    train_baseline(csv_path=args.csv)
