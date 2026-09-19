"""Trains PyTorch Deep Residual MLP on high-frequency Polymarket dataset."""

import argparse
from pathlib import Path
from typing import Tuple

import numpy as np
import torch
import torch.nn as nn
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score

from dataset import create_dataloaders, prepare_ml_data
from models import PolymarketMLP


def evaluate_model(
    model: nn.Module,
    loader: torch.utils.data.DataLoader,
    criterion: nn.Module,
    device: torch.device,
) -> Tuple[float, float, float, float]:
    """Computes average loss, accuracy, ROC-AUC, and Brier score on a dataset loader."""
    model.eval()
    total_loss = 0.0
    all_targets = []
    all_probs = []

    with torch.no_grad():
        for batch_x, batch_y in loader:
            batch_x = batch_x.to(device)
            batch_y = batch_y.to(device)

            logits = model(batch_x)
            loss = criterion(logits, batch_y)
            total_loss += loss.item() * len(batch_x)

            probs = torch.sigmoid(logits).cpu().numpy().flatten()
            targets = batch_y.cpu().numpy().flatten()

            all_probs.extend(probs)
            all_targets.extend(targets)

    n = len(all_targets)
    avg_loss = total_loss / max(1, n)
    y_true = np.array(all_targets)
    y_prob = np.array(all_probs)
    y_pred = (y_prob >= 0.5).astype(int)

    acc = accuracy_score(y_true, y_pred)
    brier = brier_score_loss(y_true, y_prob)
    has_both = len(np.unique(y_true)) > 1
    auc = roc_auc_score(y_true, y_prob) if has_both else 0.5

    return avg_loss, acc, auc, brier


def train_neural_network(
    csv_path: str = "data/dataset/dataset.csv",
    epochs: int = 50,
    batch_size: int = 64,
    lr: float = 1e-3,
    hidden_dim: int = 128,
    dropout: float = 0.25,
    patience: int = 10,
) -> None:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device: {device}")

    print(f"Loading and preprocessing data from {csv_path}...")
    data = prepare_ml_data(csv_path=csv_path, train_ratio=0.70, val_ratio=0.15)
    train_loader, val_loader, test_loader = create_dataloaders(data, batch_size=batch_size)

    input_dim = len(data["feature_cols"])
    print(f"Input features: {input_dim}")
    print(f"Train samples: {len(data['X_train'])}, Val samples: {len(data['X_val'])}, Test samples: {len(data['X_test'])}")

    model = PolymarketMLP(
        input_dim=input_dim,
        hidden_dim=hidden_dim,
        num_res_blocks=2,
        dropout=dropout,
    ).to(device)

    criterion = nn.BCEWithLogitsLoss()
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode="min", factor=0.5, patience=3
    )

    ckpt_dir = Path("ml/checkpoints")
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    best_model_path = ckpt_dir / "best_mlp.pt"

    best_val_loss = float("inf")
    patience_counter = 0

    print("\n--- Starting Neural Network Training ---")
    for epoch in range(1, epochs + 1):
        model.train()
        train_loss = 0.0

        for batch_x, batch_y in train_loader:
            batch_x = batch_x.to(device)
            batch_y = batch_y.to(device)

            optimizer.zero_grad()
            logits = model(batch_x)
            loss = criterion(logits, batch_y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()

            train_loss += loss.item() * len(batch_x)

        train_loss /= len(data["X_train"])

        # Validation phase
        if val_loader:
            val_loss, val_acc, val_auc, val_brier = evaluate_model(
                model, val_loader, criterion, device
            )
            scheduler.step(val_loss)

            if val_loss < best_val_loss:
                best_val_loss = val_loss
                patience_counter = 0
                torch.save(
                    {
                        "model_state": model.state_dict(),
                        "feature_cols": data["feature_cols"],
                        "input_dim": input_dim,
                        "hidden_dim": hidden_dim,
                    },
                    best_model_path,
                )
                save_msg = " [BEST SAVED]"
            else:
                patience_counter += 1
                save_msg = ""

            if epoch % 5 == 0 or epoch == 1 or save_msg:
                print(
                    f"Epoch {epoch:3d}/{epochs:3d} | "
                    f"Train Loss: {train_loss:.4f} | "
                    f"Val Loss: {val_loss:.4f} | "
                    f"Val Acc: {val_acc*100:.1f}% | "
                    f"Val AUC: {val_auc:.4f} | "
                    f"Val Brier: {val_brier:.4f}{save_msg}"
                )

            if patience_counter >= patience:
                print(f"Early stopping triggered at epoch {epoch} (no improvement in {patience} epochs).")
                break
        else:
            if epoch % 5 == 0 or epoch == 1:
                print(f"Epoch {epoch:3d}/{epochs:3d} | Train Loss: {train_loss:.4f}")
            torch.save(
                {
                    "model_state": model.state_dict(),
                    "feature_cols": data["feature_cols"],
                    "input_dim": input_dim,
                    "hidden_dim": hidden_dim,
                },
                best_model_path,
            )

    # Test phase using the best checkpoint
    print("\n--- Final Evaluation on Test Set ---")
    if best_model_path.exists():
        checkpoint = torch.load(best_model_path, map_location=device, weights_only=True)
        model.load_state_dict(checkpoint["model_state"])

    eval_loader = test_loader if test_loader else train_loader
    split_name = "Test" if test_loader else "Train"
    test_loss, test_acc, test_auc, test_brier = evaluate_model(
        model, eval_loader, criterion, device
    )

    print(f"[{split_name} Set Results]")
    print(f"  Loss:        {test_loss:.4f}")
    print(f"  Accuracy:    {test_acc:.4f} ({test_acc*100:.1f}%)")
    print(f"  ROC-AUC:     {test_auc:.4f}")
    print(f"  Brier Score: {test_brier:.4f}")
    print(f"Best model saved to: {best_model_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train Neural Network for Polymarket Up/Down 5m.")
    parser.add_argument("--csv", type=str, default="data/dataset/dataset.csv")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--hidden-dim", type=int, default=128)
    args = parser.parse_args()

    train_neural_network(
        csv_path=args.csv,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        hidden_dim=args.hidden_dim,
    )
