"""Deep Multi-Layer Perceptron (MLP) with Residual Connections for Tabular Market Data."""

import torch
import torch.nn as nn


class ResidualBlock(nn.Module):
    """Residual dense block with batch normalization, LeakyReLU, and dropout."""

    def __init__(self, hidden_dim: int, dropout: float = 0.2):
        super().__init__()
        self.fc1 = nn.Linear(hidden_dim, hidden_dim)
        self.bn1 = nn.BatchNorm1d(hidden_dim)
        self.act = nn.LeakyReLU(negative_slope=0.1)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.bn2 = nn.BatchNorm1d(hidden_dim)
        self.drop = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x
        out = self.fc1(x)
        out = self.bn1(out)
        out = self.act(out)
        out = self.drop(out)
        out = self.fc2(out)
        out = self.bn2(out)
        out = self.act(out + residual)
        return out


class PolymarketMLP(nn.Module):
    """Deep Tabular Neural Network for binary outcome prediction (UP vs DOWN)."""

    def __init__(
        self,
        input_dim: int,
        hidden_dim: int = 128,
        num_res_blocks: int = 2,
        dropout: float = 0.25,
    ):
        super().__init__()

        # Input projection
        self.input_layer = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.BatchNorm1d(hidden_dim),
            nn.LeakyReLU(negative_slope=0.1),
            nn.Dropout(dropout),
        )

        # Residual backbone
        res_blocks = [
            ResidualBlock(hidden_dim=hidden_dim, dropout=dropout)
            for _ in range(num_res_blocks)
        ]
        self.backbone = nn.Sequential(*res_blocks)

        # Output head
        self.head = nn.Sequential(
            nn.Linear(hidden_dim, hidden_dim // 2),
            nn.BatchNorm1d(hidden_dim // 2),
            nn.LeakyReLU(negative_slope=0.1),
            nn.Dropout(dropout / 2),
            nn.Linear(hidden_dim // 2, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Outputs raw logits for BCEWithLogitsLoss."""
        x = self.input_layer(x)
        x = self.backbone(x)
        logits = self.head(x)
        return logits

    @torch.no_grad()
    def predict_proba(self, x: torch.Tensor) -> torch.Tensor:
        """Returns predicted probability of outcome UP in range [0.0, 1.0]."""
        self.eval()
        logits = self.forward(x)
        return torch.sigmoid(logits)
