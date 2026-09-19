import { describe, expect, it } from "vitest";
import { DatasetBuilder } from "../src/dataset/dataset-builder.js";
import type { MarketSnapshot } from "../src/types/market.js";

const mockSnapshot = (slug: string, ts: number, btcPrice: number, clPrice?: number): MarketSnapshot => ({
  timestampUtc: new Date(ts).toISOString(),
  timestampMs: ts,
  market: {
    marketId: "0xcond",
    slug,
    startTimeMs: ts - 10000,
    endTimeMs: ts + 10000,
  },
  btc: {
    price: btcPrice,
    chainlinkPrice: clPrice ?? btcPrice,
  },
  polymarket: {
    up: { bid: 0.5, ask: 0.52, mid: 0.51, spread: 0.02, bidSize: 100, askSize: 50 },
    down: { bid: 0.48, ask: 0.5, mid: 0.49, spread: 0.02, bidSize: 50, askSize: 100 },
  },
});

describe("DatasetBuilder", () => {
  it("groups snapshots by market window and applies correct labels and features", () => {
    const builder = new DatasetBuilder();
    const snaps: MarketSnapshot[] = [
      // Window 1: upward
      mockSnapshot("window-1", 1000, 70000, 70000),
      mockSnapshot("window-1", 2000, 70100, 70100),
      mockSnapshot("window-1", 3000, 70200, 70200),

      // Window 2: downward
      mockSnapshot("window-2", 4000, 70200, 70200),
      mockSnapshot("window-2", 5000, 70100, 70100),
      mockSnapshot("window-2", 6000, 70000, 70000),
    ];

    const res = builder.buildDataset(snaps);

    expect(res.validWindows).toBe(2);
    expect(res.records).toHaveLength(6);
    expect(res.upCount).toBe(1);
    expect(res.downCount).toBe(1);

    const w1Records = res.records.filter((r) => r.slug === "window-1");
    expect(w1Records).toHaveLength(3);
    for (const r of w1Records) {
      expect(r.target).toBe(1);
      expect(r.label).toBe("UP");
      expect(r.windowStartPrice).toBe(70000);
      expect(r.windowEndPrice).toBe(70200);
    }

    const w2Records = res.records.filter((r) => r.slug === "window-2");
    expect(w2Records).toHaveLength(3);
    for (const r of w2Records) {
      expect(r.target).toBe(0);
      expect(r.label).toBe("DOWN");
      expect(r.windowStartPrice).toBe(70200);
      expect(r.windowEndPrice).toBe(70000);
    }
  });

  it("exports correctly to CSV and JSONL", () => {
    const builder = new DatasetBuilder();
    const snaps: MarketSnapshot[] = [
      mockSnapshot("window-1", 1000, 70000, 70000),
      mockSnapshot("window-1", 2000, 70100, 70100),
    ];

    const res = builder.buildDataset(snaps);
    const csv = builder.toCsv(res.records);
    const jsonl = builder.toJsonl(res.records);

    expect(csv).toContain("timestampMs,timestampUtc,slug");
    expect(csv).toContain("window-1");
    expect(csv.split("\n")).toHaveLength(3); // header + 2 records

    expect(jsonl.split("\n")).toHaveLength(2);
    const parsed = JSON.parse(jsonl.split("\n")[0]!) as { slug: string; target: number };
    expect(parsed.slug).toBe("window-1");
    expect(parsed.target).toBe(1);
  });
});
