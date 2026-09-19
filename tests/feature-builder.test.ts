import { describe, expect, it } from "vitest";
import {
  FeatureBuilder,
  calculateRealizedVol,
  findClosestPriorIndex,
  orderBookImbalance,
  safeMid,
  safeSpread,
} from "../src/dataset/feature-builder.js";
import type { MarketSnapshot } from "../src/types/market.js";

const mockSnapshot = (ts: number, btcPrice: number, clPrice?: number, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  timestampUtc: new Date(ts).toISOString(),
  timestampMs: ts,
  market: {
    marketId: "0xcond",
    slug: "btc-updown-5m-1789200000",
    startTimeMs: 1789200000000,
    endTimeMs: 1789200300000,
    secondsRemaining: Math.max(0, Math.floor((1789200300000 - ts) / 1000)),
  },
  btc: {
    price: btcPrice,
    bid: btcPrice - 0.5,
    ask: btcPrice + 0.5,
    volume: 10,
    buyVolume: 6,
    sellVolume: 4,
    chainlinkPrice: clPrice ?? btcPrice,
  },
  polymarket: {
    up: { bid: 0.51, ask: 0.53, mid: 0.52, spread: 0.02, bidSize: 100, askSize: 50 },
    down: { bid: 0.47, ask: 0.49, mid: 0.48, spread: 0.02, bidSize: 50, askSize: 100 },
  },
  sequence: 1,
  ...over,
});

describe("FeatureBuilder helpers", () => {
  it("computes order book imbalance correctly", () => {
    expect(orderBookImbalance(100, 50)).toBeCloseTo((100 - 50) / 150);
    expect(orderBookImbalance(50, 100)).toBeCloseTo((50 - 100) / 150);
    expect(orderBookImbalance(100, 100)).toBe(0);
    expect(orderBookImbalance(0, 0)).toBe(0);
  });

  it("calculates safeSpread and safeMid", () => {
    expect(safeSpread(10, 12)).toBe(2);
    expect(safeSpread(undefined, 12)).toBe(0);
    expect(safeMid(10, 12)).toBe(11);
    expect(safeMid(undefined, 12)).toBe(12);
  });

  it("finds the closest prior index using binary search", () => {
    const snaps = [
      mockSnapshot(1000, 100),
      mockSnapshot(2000, 101),
      mockSnapshot(3000, 102),
      mockSnapshot(4000, 103),
      mockSnapshot(5000, 104),
    ];
    expect(findClosestPriorIndex(snaps, 2500, 4)).toBe(1); // timestamp 2000
    expect(findClosestPriorIndex(snaps, 3000, 4)).toBe(2); // timestamp 3000
    expect(findClosestPriorIndex(snaps, 500, 4)).toBe(0);
  });

  it("computes realized volatility accurately", () => {
    const flatPrices = [100, 100, 100, 100];
    expect(calculateRealizedVol(flatPrices)).toBe(0);

    const volatilePrices = [100, 105, 95, 102, 98];
    const vol = calculateRealizedVol(volatilePrices);
    expect(vol).toBeGreaterThan(0);
  });
});

describe("FeatureBuilder", () => {
  it("extracts multi-scale returns and market signals across a time series", () => {
    const builder = new FeatureBuilder();
    const baseMs = 1789200000000;
    const snaps: MarketSnapshot[] = [];

    // Create 30 snapshots spaced 1 second apart with an upward trend
    for (let i = 0; i < 30; i++) {
      const ts = baseMs + i * 1000;
      const price = 70000 + i * 10;
      snaps.push(mockSnapshot(ts, price, price + 2));
    }

    const features = builder.buildFeatures(snaps);
    expect(features).toHaveLength(30);

    // Initial snapshot should have 0 return
    expect(features[0]!.btcReturn1s).toBe(0);
    expect(features[0]!.btcReturn5s).toBe(0);

    // Later snapshot (at t=10s) should have positive return
    const f10 = features[10]!;
    expect(f10.btcPrice).toBe(70100);
    expect(f10.btcReturn1s).toBeCloseTo((70100 - 70090) / 70090);
    expect(f10.btcReturn5s).toBeCloseTo((70100 - 70050) / 70050);
    expect(f10.chainlinkBinanceBasis).toBeCloseTo(2.0);

    // Polymarket OBI & Probabilities
    expect(f10.upOrderBookImbalance).toBeCloseTo((100 - 50) / 150);
    expect(f10.downOrderBookImbalance).toBeCloseTo((50 - 100) / 150);
    expect(f10.upDownSpreadSum).toBeCloseTo(0.52 + 0.48);
    expect(f10.pmImpliedProbUp).toBeCloseTo(0.52 / 1.0);
  });
});
