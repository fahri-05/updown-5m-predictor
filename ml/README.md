# Polymarket 5m ML & Neural Network Pipeline 🧠

This directory contains the Machine Learning and Deep Learning (PyTorch) training pipeline for predicting the binary outcome (**UP / DOWN**) of Polymarket's 5-minute crypto markets.

---

## 📁 Directory Structure

```text
ml/
├── checkpoints/          # Trained models (.pt, .joblib, .txt) & scaler
├── models/
│   ├── __init__.py
│   └── mlp.py            # PyTorch Deep Residual MLP architecture
├── dataset.py            # DataLoader, preprocessing & chronological window splitter
├── train_baseline.py     # Benchmark training (LightGBM & Logistic Regression)
├── train_nn.py           # PyTorch training loop (Residual MLP + Early Stopping)
├── evaluate.py           # Accuracy, Brier score, & edge-vs-market simulation
├── predict.py            # Fast real-time inference script
├── requirements.txt      # Python dependencies
└── README.md
```

---

## ⚙️ Installing Dependencies

Make sure the Python dependencies are installed:

```bash
pip install -r ml/requirements.txt
```

---

## 🏃 Execution Guide

### 1. Build the Dataset First
Make sure the latest dataset has been extracted from the snapshots:
```bash
npm run dataset:build
```
The dataset file will be saved at `data/dataset/dataset.csv`.

---

### 2. Train the Baseline Models (Benchmark)
Run the benchmark using **LightGBM** and **Logistic Regression**:
```bash
python3 ml/train_baseline.py
```
The output includes:
- *Accuracy*
- *ROC-AUC*
- *Brier Score* (measures probability calibration)
- **Top 10 Feature Importance** (the features that most influence market movement)

The models are saved automatically to `ml/checkpoints/baseline_lgbm.txt` and `ml/checkpoints/baseline_lr.joblib`.

---

### 3. Train the Neural Network (PyTorch Deep Residual MLP)
Run training for the PyTorch Deep MLP architecture:
```bash
python3 ml/train_nn.py --epochs 40 --lr 0.001 --hidden-dim 128
```
NN architecture features:
- **Residual Blocks (Skip Connections)**: Prevent *vanishing gradients* on tabular data.
- **Batch Normalization & LeakyReLU**: Stabilize the gradient distribution.
- **Dropout Regularization**: Prevents *overfitting* to microstructure market noise.
- **Early Stopping & Learning Rate Scheduler**: Stops training when validation loss no longer improves.

The best model is saved to `ml/checkpoints/best_mlp.pt`.

---

### 4. Trading Edge Simulation Evaluation
Test whether the model's predicted probabilities have a statistical edge against Polymarket's market prices:
```bash
python3 ml/evaluate.py --model nn --edge 0.05
```
Parameters:
- `--model`: `nn` (Neural Network) or `lr` (Logistic Regression).
- `--edge`: The minimum probability difference versus Polymarket odds before a simulated bet is placed (e.g. `0.05 = 5%`).

Output metrics include:
- Triggered signals (*total signals*)
- Simulated win rate
- Simulated net PnL & ROI

---

### 5. Real-Time Inference
Run a prediction on a new data sample:
```bash
python3 ml/predict.py
```
Or pass JSON input directly:
```bash
python3 ml/predict.py --json '{"secondsRemaining": 90, "btcReturn15s": 0.002, "upOrderBookImbalance": 0.4, "pmImpliedProbUp": 0.52}'
```
Output:
```text
--- Model Inference Result ---
  Predicted Side:  UP
  P(UP):           78.40%
  P(DOWN):         21.60%
  Confidence:      78.40%
  Market Implied:  52.00%
  Estimated Edge:  +26.40%
```

---

## 🛡️ Anti-Leakage & Titik Rawan Mitigation (Early vs Late Window Evaluation)

### ⚠️ Titik Rawan: Market Price Convergence vs True Alpha
Features like `pmImpliedProbUp` and `upOrderBookImbalance` are taken directly from the Polymarket contract being predicted.
- **Late Window (`0–60s` remaining)**: The outcome is usually already clear because Bitcoin has moved, and market makers/arbitrageurs have already bid up the winning token to near 1.00 and sold off the losing token to near 0.00. While causal (not look-ahead data leakage), a model evaluating only aggregate accuracy risks appearing accurate merely by mirroring the Polymarket consensus near expiry, rather than finding actionable predictive edge.
- **Early Window (`240–300s` remaining)**: Uncertainty is maximal and Polymarket implied odds hover near ~50%. **This is where true predictive edge lives.**

### 📊 Time-Segmented Window Evaluation
Evaluate performance segmented by `secondsRemaining` to measure whether the model adds value when uncertainty is high:

```bash
# Full 60-second window breakdown (240–300s, 180–240s, 120–180s, 60–120s, 0–60s)
python3 ml/evaluate.py --model nn

# Explicit Early (240–300s) vs Late (0–60s) Window Comparison
python3 ml/evaluate.py --model nn --compare-early-late

# Evaluate strictly on chronological Test split
python3 ml/evaluate.py --model nn --test-only

# Custom time slices
python3 ml/evaluate.py --model lr --buckets "0-60,60-180,180-300"
```

Output includes comparative ML classification metrics (Model Accuracy vs Polymarket Benchmark Accuracy, Brier Skill Score) and financial edge simulation (Triggered Bets, Win Rate, Net PnL, ROI) for each window slice, followed by an automated **Titik Rawan Diagnostic Summary**.

### 🧪 Ablation Study: Training Without Polymarket Features
To isolate pure exogenous Bitcoin alpha from Polymarket orderbook mirroring, train models with `--exclude-pm-features`:

```bash
# Train baseline benchmark without Polymarket features
python3 ml/train_baseline.py --exclude-pm-features

# Train PyTorch MLP without Polymarket features
python3 ml/train_nn.py --exclude-pm-features
```

When `--exclude-pm-features` is set, all Polymarket-specific orderbook features (`pmImpliedProbUp`, `upOrderBookImbalance`, `downOrderBookImbalance`, `upBid`, etc.) are removed, forcing the model to rely solely on high-frequency Binance order flow, multi-scale returns, volatility dynamics, and Chainlink oracle divergences.

---

## 🛡️ Anti-Leakage Principles (No Look-Ahead Bias)

1. **Chronological Splitting**:
   - The *Train / Validation / Test* split is done chronologically based on market window order (`slug`).
   - Data is never randomly shuffled across time, so future data never leaks into the training set.
2. **Strictly Causal Scaling**:
   - `StandardScaler` is fit only on the *Train* data. Validation, test, and live inference data only use the transform with parameters learned from the training data.
3. **Time-Segmented Benchmarking**:
   - Model accuracy and Brier score are continuously benchmarked against Polymarket's own implied probability (`pmImpliedProbUp`) across discrete maturity buckets (`secondsRemaining`).
