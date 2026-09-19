import { describe, expect, it } from "vitest";
import { MarketState } from "../src/engine/market-state.js";
import type {
  BtcMarketEvent,
  PolymarketMarketEvent,
} from "../src/types/market.js";

const btcTrade = (price: number, qty: number, buyerMaker: boolean): BtcMarketEvent => ({
  type: "trade",
  timestampUtc: new Date(1_700_000_000_000 + (price * 0)).toISOString(),
  timestampMs: 1_700_000_000_000,
  symbol: "BTCUSDT",
  price,
  quantity: qty,
  source: "binance",
  receivedTimestampMs: 1_700_000_000_000,
  isBuyerMaker: buyerMaker,
});

const pmBook = (
  outcome: "UP" | "DOWN",
  bid: number | undefined,
  ask: number | undefined,
  bidSize = 100,
  askSize = 200,
): PolymarketMarketEvent => ({
  type: "book",
  timestampUtc: "2026-09-10T14:00:01.000Z",
  timestampMs: 1_787_000_000_000,
  marketId: "0xabc",
  conditionId: "0xabc",
  tokenId: outcome === "UP" ? "u1" : "d1",
  outcome,
  bidPrice: bid,
  askPrice: ask,
  bidSize,
  askSize,
  source: "polymarket",
  receivedTimestampMs: 1_787_000_000_000,
});

describe("MarketState snapshot merging", () => {
  it("merges BTC trade + PM books into one snapshot", () => {
    const state = new MarketState();
    state.applyBtcEvent(btcTrade(77318.5, 0.5, true));
    state.applyPolymarketEvent(pmBook("UP", 0.94, 0.96));
    state.applyPolymarketEvent(pmBook("DOWN", 0.04, 0.06));
    const snap = state.snapshot(1_787_000_100_000);

    expect(snap.btc.price).toBe(77318.5);
    expect(snap.polymarket.up.bid).toBe(0.94);
    expect(snap.polymarket.up.ask).toBe(0.96);
    expect(snap.polymarket.up.mid).toBe(0.95);
    expect(snap.polymarket.up.spread).toBe(0.02);
    expect(snap.polymarket.down.bid).toBe(0.04);
    expect(snap.polymarket.down.ask).toBe(0.06);
    expect(typeof snap.sequence).toBe("number");
  });

  it("omits optional fields when data is unavailable (no fake zeros)", () => {
    const state = new MarketState();
    const snap = state.snapshot(1_700_000_000_000);
    expect(snap.btc.price).toBeUndefined();
    expect(snap.btc.buyVolume).toBeUndefined();
    expect(snap.polymarket.up.bid).toBeUndefined();
    expect(snap.polymarket.up.ask).toBeUndefined();
    expect(snap.polymarket.up.mid).toBeUndefined();
    expect(snap.market.secondsRemaining).toBeUndefined();
  });

  it("tracks buy/sell volume by isBuyerMaker", () => {
    const state = new MarketState();
    state.applyBtcEvent(btcTrade(1000, 2, false)); // aggressive buyer
    state.applyBtcEvent(btcTrade(1000, 3, true)); // aggressive seller
    const snap = state.snapshot(1_700_000_000_000);
    expect(snap.btc.volume).toBe(5);
    expect(snap.btc.buyVolume).toBe(2);
    expect(snap.btc.sellVolume).toBe(3);
  });

  it("secondsRemaining clamps to zero at/after window end", () => {
    const state = new MarketState();
    state.setMarketMeta({
      marketId: "m",
      windowEndMs: 1_800_000_000_000,
    });
    const before = state.snapshot(1_800_000_000_000 - 1000); // 1s before end
    expect(before.market.secondsRemaining).toBe(1);
    const atEnd = state.snapshot(1_800_000_000_000);
    expect(atEnd.market.secondsRemaining).toBe(0);
    const after = state.snapshot(1_800_001_000_000); // past end
    expect(after.market.secondsRemaining).toBe(0);
  });

  it("does not compute the market label (causality)", () => {
    const state = new MarketState();
    state.applyBtcEvent(btcTrade(100, 1, false));
    const snap = state.snapshot(1_700_000_000_000);
    expect("label" in snap).toBe(false);
    expect(snap.btc.price).toBe(100);
  });
});