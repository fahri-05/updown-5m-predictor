/**
 * FeatureBuilder — transforms raw MarketSnapshot series into ML-ready technical features.
 *
 * Feature groups:
 *  1. Multi-scale BTC returns: 1s, 5s, 15s, 60s, 300s
 *  2. Realized Volatility: 5s, 15s, 60s
 *  3. Order Book Imbalance (OBI) & Spreads:
 *     - Polymarket UP OBI & Spread
 *     - Polymarket DOWN OBI & Spread
 *     - Binance BTC Spread & Mid
 *  4. Volume dynamics: volume delta, buy/sell volume ratio, net volume
 *  5. Cross-market signals:
 *     - Chainlink BTC vs Binance BTC basis (latency & deviation)
 *     - Polymarket implied UP probability & discount/premium (upMid + downMid - 1)
 *  6. Time-to-maturity: seconds remaining, fraction of window elapsed
 */

import type { MarketSnapshot } from "../types/market.js";

export interface SnapshotFeatures {
  // Identification & Timestamps
  timestampMs: number;
  timestampUtc: string;
  slug: string;
  conditionId: string;
  sequence: number;

  // Time Features
  secondsRemaining: number;
  fractionElapsed: number;

  // BTC Price & Multi-scale Returns
  btcPrice: number;
  btcReturn1s: number;
  btcReturn5s: number;
  btcReturn15s: number;
  btcReturn60s: number;
  btcReturn300s: number;

  // BTC Realized Volatility
  btcVol5s: number;
  btcVol15s: number;
  btcVol60s: number;

  // BTC Orderbook & Spread
  btcBid: number;
  btcAsk: number;
  btcSpread: number;
  btcMid: number;

  // BTC Volume Dynamics
  btcVolumeDelta5s: number;
  btcBuySellRatio: number;
  btcNetVolume: number;

  // Chainlink Reference Features
  chainlinkPrice: number;
  chainlinkReturn5s: number;
  chainlinkReturn15s: number;
  chainlinkBinanceBasis: number;

  // Polymarket UP Outcome Features
  upBid: number;
  upAsk: number;
  upMid: number;
  upSpread: number;
  upBidSize: number;
  upAskSize: number;
  upOrderBookImbalance: number;
  upLastTradePrice: number;

  // Polymarket DOWN Outcome Features
  downBid: number;
  downAsk: number;
  downMid: number;
  downSpread: number;
  downBidSize: number;
  downAskSize: number;
  downOrderBookImbalance: number;
  downLastTradePrice: number;

  // Cross-Outcome Market Inefficiency Signals
  upDownSpreadSum: number;
  pmImpliedProbUp: number;
}

export interface FeatureBuilderOptions {
  returnScalesSec?: number[];
  volScalesSec?: number[];
}

export function orderBookImbalance(bidSize?: number, askSize?: number): number {
  const b = bidSize ?? 0;
  const a = askSize ?? 0;
  const sum = b + a;
  if (sum <= 0) return 0;
  return (b - a) / sum;
}

export function safeSpread(bid?: number, ask?: number): number {
  if (bid === undefined || ask === undefined) return 0;
  return ask - bid;
}

export function safeMid(bid?: number, ask?: number): number {
  if (bid === undefined && ask === undefined) return 0;
  if (bid === undefined) return ask!;
  if (ask === undefined) return bid!;
  return (bid + ask) / 2;
}

/** Binary search to find the latest snapshot at or before targetTimeMs. */
export function findClosestPriorIndex(
  snapshots: MarketSnapshot[],
  targetTimeMs: number,
  currentIndex: number,
): number {
  if (currentIndex <= 0 || snapshots.length === 0) return 0;
  if (snapshots[0]!.timestampMs >= targetTimeMs) return 0;
  if (snapshots[currentIndex]!.timestampMs <= targetTimeMs) return currentIndex;

  let low = 0;
  let high = currentIndex;
  let best = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const ts = snapshots[mid]!.timestampMs;
    if (ts <= targetTimeMs) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** Calculates realized volatility (sample std dev of consecutive returns) over a price series. */
export function calculateRealizedVol(prices: number[]): number {
  if (prices.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1]!;
    const p1 = prices[i]!;
    if (p0 > 0 && p1 > 0) {
      rets.push((p1 - p0) / p0);
    }
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((sum, r) => sum + r, 0) / rets.length;
  const variance =
    rets.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

export class FeatureBuilder {
  private returnScalesSec: number[];
  private volScalesSec: number[];

  constructor(options?: FeatureBuilderOptions) {
    this.returnScalesSec = options?.returnScalesSec ?? [1, 5, 15, 60, 300];
    this.volScalesSec = options?.volScalesSec ?? [5, 15, 60];
  }

  /**
   * Builds features for a sequence of snapshots.
   * Assumes snapshots are sorted in chronological order.
   */
  buildFeatures(snapshots: MarketSnapshot[]): SnapshotFeatures[] {
    const result: SnapshotFeatures[] = [];
    if (snapshots.length === 0) return result;

    for (let i = 0; i < snapshots.length; i++) {
      result.push(this.buildSingleSnapshotFeatures(snapshots, i));
    }

    return result;
  }

  /**
   * Computes features for a single snapshot at index i without future lookahead.
   */
  buildSingleSnapshotFeatures(snapshots: MarketSnapshot[], i: number): SnapshotFeatures {
    const current = snapshots[i]!;
    const nowMs = current.timestampMs;

    const btcPrice = current.btc.price ?? current.btc.bid ?? current.btc.ask ?? 0;
    const chainlinkPrice = current.btc.chainlinkPrice ?? btcPrice;

    // 1. Returns calculation
    const returnAtLag = (lagSec: number, priceExtractor: (s: MarketSnapshot) => number): number => {
      const targetTime = nowMs - lagSec * 1000;
      const priorIdx = findClosestPriorIndex(snapshots, targetTime, i);
      const priorPrice = priceExtractor(snapshots[priorIdx]!);
      const currPrice = priceExtractor(current);
      if (priorPrice <= 0 || currPrice <= 0) return 0;
      return (currPrice - priorPrice) / priorPrice;
    };

    const btcExtractor = (s: MarketSnapshot) => s.btc.price ?? s.btc.bid ?? s.btc.ask ?? 0;
    const clExtractor = (s: MarketSnapshot) => s.btc.chainlinkPrice ?? btcExtractor(s);

    const btcReturn1s = returnAtLag(1, btcExtractor);
    const btcReturn5s = returnAtLag(5, btcExtractor);
    const btcReturn15s = returnAtLag(15, btcExtractor);
    const btcReturn60s = returnAtLag(60, btcExtractor);
    const btcReturn300s = returnAtLag(300, btcExtractor);

    const chainlinkReturn5s = returnAtLag(5, clExtractor);
    const chainlinkReturn15s = returnAtLag(15, clExtractor);

    // 2. Realized Volatility
    const volAtWindow = (windowSec: number): number => {
      const targetTime = nowMs - windowSec * 1000;
      const startIdx = findClosestPriorIndex(snapshots, targetTime, i);
      const windowPrices: number[] = [];
      for (let k = startIdx; k <= i; k++) {
        const p = btcExtractor(snapshots[k]!);
        if (p > 0) windowPrices.push(p);
      }
      return calculateRealizedVol(windowPrices);
    };

    const btcVol5s = volAtWindow(5);
    const btcVol15s = volAtWindow(15);
    const btcVol60s = volAtWindow(60);

    // 3. Volume dynamics
    const prior5sIdx = findClosestPriorIndex(snapshots, nowMs - 5000, i);
    const volumeDelta5s = (current.btc.volume ?? 0) - (snapshots[prior5sIdx]?.btc.volume ?? 0);
    const buyVol = current.btc.buyVolume ?? 0;
    const sellVol = current.btc.sellVolume ?? 0;
    const totVol = buyVol + sellVol;
    const btcBuySellRatio = totVol > 0 ? buyVol / totVol : 0.5;
    const btcNetVolume = buyVol - sellVol;

    // 4. Orderbook & Spreads
    const btcBid = current.btc.bid ?? btcPrice;
    const btcAsk = current.btc.ask ?? btcPrice;
    const btcSpread = btcAsk - btcBid;
    const btcMid = (btcBid + btcAsk) / 2;

    const up = current.polymarket.up;
    const down = current.polymarket.down;

    const upBid = up.bid ?? 0;
    const upAsk = up.ask ?? 0;
    const upMid = up.mid ?? safeMid(upBid, upAsk);
    const upSpread = up.spread ?? safeSpread(upBid, upAsk);
    const upBidSize = up.bidSize ?? 0;
    const upAskSize = up.askSize ?? 0;
    const upOBI = orderBookImbalance(upBidSize, upAskSize);
    const upLastTrade = up.lastTradePrice ?? upMid;

    const downBid = down.bid ?? 0;
    const downAsk = down.ask ?? 0;
    const downMid = down.mid ?? safeMid(downBid, downAsk);
    const downSpread = down.spread ?? safeSpread(downBid, downAsk);
    const downBidSize = down.bidSize ?? 0;
    const downAskSize = down.askSize ?? 0;
    const downOBI = orderBookImbalance(downBidSize, downAskSize);
    const downLastTrade = down.lastTradePrice ?? downMid;

    // 5. Cross-Outcome & Cross-Market Signals
    const upDownSpreadSum = upMid + downMid;
    const pmImpliedProbUp = upDownSpreadSum > 0 ? upMid / upDownSpreadSum : 0.5;
    const chainlinkBinanceBasis = btcPrice > 0 ? chainlinkPrice - btcPrice : 0;

    // 6. Time Features
    const windowStartMs = current.market.startTimeMs ?? (nowMs - 300_000);
    const windowEndMs = current.market.endTimeMs ?? (nowMs + 300_000);
    const windowDuration = Math.max(1, windowEndMs - windowStartMs);
    const secondsRemaining = Math.max(0, Math.floor((windowEndMs - nowMs) / 1000));
    const fractionElapsed = Math.min(1, Math.max(0, (nowMs - windowStartMs) / windowDuration));

    return {
      timestampMs: nowMs,
      timestampUtc: current.timestampUtc,
      slug: current.market.slug ?? "",
      conditionId: current.market.conditionId ?? current.market.marketId ?? "",
      sequence: current.sequence ?? i,

      secondsRemaining,
      fractionElapsed,

      btcPrice,
      btcReturn1s,
      btcReturn5s,
      btcReturn15s,
      btcReturn60s,
      btcReturn300s,

      btcVol5s,
      btcVol15s,
      btcVol60s,

      btcBid,
      btcAsk,
      btcSpread,
      btcMid,

      btcVolumeDelta5s: Math.max(0, volumeDelta5s),
      btcBuySellRatio,
      btcNetVolume,

      chainlinkPrice,
      chainlinkReturn5s,
      chainlinkReturn15s,
      chainlinkBinanceBasis,

      upBid,
      upAsk,
      upMid,
      upSpread,
      upBidSize,
      upAskSize,
      upOrderBookImbalance: upOBI,
      upLastTradePrice: upLastTrade,

      downBid,
      downAsk,
      downMid,
      downSpread,
      downBidSize,
      downAskSize,
      downOrderBookImbalance: downOBI,
      downLastTradePrice: downLastTrade,

      upDownSpreadSum,
      pmImpliedProbUp,
    };
  }
}