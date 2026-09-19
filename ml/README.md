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

## 🛡️ Anti-Leakage Principles (No Look-Ahead Bias)

1. **Chronological Splitting**:
   - The *Train / Validation / Test* split is done chronologically based on market window order (`slug`).
   - Data is never randomly shuffled across time, so future data never leaks into the training set.
2. **Strictly Causal Scaling**:
   - `StandardScaler` is fit only on the *Train* data. Validation, test, and live inference data only use the transform with parameters learned from the training data.
