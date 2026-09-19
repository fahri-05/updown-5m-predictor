import { describe, expect, it } from "vitest";
import { ResolutionLabelBuilder } from "../src/dataset/label-builder.js";
import type { MarketSnapshot, BtcMarketEvent } from "../src/types/market.js";

const mockSnapshot = (ts: number, btcPrice: number, clPrice?: number): MarketSnapshot => ({
  timestampUtc: new Date(ts).toISOString(),
  timestampMs: ts,
  market: {
    marketId: "0xcond",
    slug: "btc-updown-5m-1789200000",
    startTimeMs: 1789200000000,
    endTimeMs: 1789200300000,
  },
  btc: {
    price: btcPrice,
    chainlinkPrice: clPrice,
  },
  polymarket: {
    up: {},
    down: {},
  },
});

describe("ResolutionLabelBuilder", () => {
  const labelBuilder = new ResolutionLabelBuilder();

  it("labels UP (1) when Chainlink end price >= start price", () => {
    const snaps = [
      mockSnapshot(1789200000000, 70000, 70000),
      mockSnapshot(1789200150000, 70050, 70050),
      mockSnapshot(1789200300000, 70100, 70100),
    ];

    const label = labelBuilder.buildLabel({
      slug: "btc-updown-5m-1789200000",
      windowStartMs: 1789200000000,
      windowEndMs: 1789200300000,
      snapshots: snaps,
    });

    expect(label.label).toBe("UP");
    expect(label.target).toBe(1);
    expect(label.startPrice).toBe(70000);
    expect(label.endPrice).toBe(70100);
    expect(label.priceDiff).toBe(100);
    expect(label.ruleId).toBe("chainlink_start_end");
  });

  it("labels DOWN (0) when Chainlink end price < start price", () => {
    const snaps = [
      mockSnapshot(1789200000000, 70000, 70000),
      mockSnapshot(1789200300000, 69900, 69900),
    ];

    const label = labelBuilder.buildLabel({
      slug: "btc-updown-5m-1789200000",
      windowStartMs: 1789200000000,
      windowEndMs: 1789200300000,
      snapshots: snaps,
    });

    expect(label.label).toBe("DOWN");
    expect(label.target).toBe(0);
    expect(label.startPrice).toBe(70000);
    expect(label.endPrice).toBe(69900);
    expect(label.priceDiff).toBe(-100);
    expect(label.ruleId).toBe("chainlink_start_end");
  });

  it("falls back to Binance spot price when Chainlink is absent", () => {
    const snaps = [
      mockSnapshot(1789200000000, 70000, undefined),
      mockSnapshot(1789200300000, 70050, undefined),
    ];

    const label = labelBuilder.buildLabel({
      slug: "btc-updown-5m-1789200000",
      windowStartMs: 1789200000000,
      windowEndMs: 1789200300000,
      snapshots: snaps,
    });

    expect(label.label).toBe("UP");
    expect(label.target).toBe(1);
    expect(label.ruleId).toBe("binance_start_end");
  });

  it("resolves from Gamma settlement metadata when provided", () => {
    const label = labelBuilder.buildLabel({
      slug: "btc-updown-5m-1789200000",
      windowStartMs: 1789200000000,
      windowEndMs: 1789200300000,
      gammaEventMetadata: {
        priceToBeat: 70000,
        finalPrice: 70050,
      },
    });

    expect(label.label).toBe("UP");
    expect(label.target).toBe(1);
    expect(label.ruleId).toBe("chainlink_resolution");
  });

  it("resolves from raw BtcMarketEvents when snapshots are absent", () => {
    const events: BtcMarketEvent[] = [
      {
        type: "ticker",
        timestampUtc: "2026-09-12T00:00:00Z",
        timestampMs: 1789200000000,
        symbol: "btc/usd",
        source: "chainlink",
        price: 70000,
        receivedTimestampMs: 1789200000000,
      },
      {
        type: "ticker",
        timestampUtc: "2026-09-12T00:05:00Z",
        timestampMs: 1789200300000,
        symbol: "btc/usd",
        source: "chainlink",
        price: 69800,
        receivedTimestampMs: 1789200300000,
      },
    ];

    const label = labelBuilder.buildLabel({
      slug: "btc-updown-5m-1789200000",
      windowStartMs: 1789200000000,
      windowEndMs: 1789200300000,
      btcEvents: events,
    });

    expect(label.label).toBe("DOWN");
    expect(label.target).toBe(0);
    expect(label.ruleId).toBe("chainlink_start_end");
  });
});
