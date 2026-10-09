import { describe, expect, it } from "vitest";
import { LevelBook } from "../src/collectors/polymarket/orderbook.js";
import { MarketState } from "../src/engine/market-state.js";
import type { PolymarketOrderBookLevel } from "../src/types/market.js";

const levels = (prices: [number, number][]): PolymarketOrderBookLevel[] =>
  prices.map(([price, size]) => ({ price, size }));

describe("LevelBook", () => {
  it("bestBid/bestAsk from a replaced book", () => {
    const book = new LevelBook();
    book.replace(
      levels([
        [0.9, 100],
        [0.95, 200],
        [0.92, 150],
      ]),
      "bids",
    );
    book.replace(
      levels([
        [0.97, 300],
        [1.0, 400],
        [0.98, 250],
      ]),
      "asks",
    );
    expect(book.bestBid).toBe(0.95);
    expect(book.bestAsk).toBe(0.97);
    expect(book.bestBidSize).toBe(200);
    expect(book.bestAskSize).toBe(300);
  });

  it("apply() adds/removes levels (size 0 removes)", () => {
    const book = new LevelBook();
    book.apply(0.9, 100, "BUY");
    book.apply(1.0, 50, "SELL");
    expect(book.bestBid).toBe(0.9);
    expect(book.bestAsk).toBe(1.0);
    // Increase an existing bid.
    book.apply(0.92, 10, "BUY");
    expect(book.bestBid).toBe(0.92);
    // Remove the top ask.
    book.apply(1.0, 0, "SELL");
    expect(book.bestAsk).toBeUndefined();
  });

  it("mid() averages best bid/ask", () => {
    const book = new LevelBook();
    book.apply(0.94, 10, "BUY");
    book.apply(0.96, 10, "SELL");
    expect(book.mid()).toBe(0.95);
  });

  it("spread is ask-bid (computed by caller via snapshot)", () => {
    const book = new LevelBook();
    book.apply(0.9, 5, "BUY");
    book.apply(0.95, 5, "SELL");
    // The order book exposes best bid/ask; spread = ask - bid.
    expect(book.bestAsk!).toBeGreaterThan(book.bestBid!);
    expect((book.bestAsk ?? 0) - (book.bestBid ?? 0)).toBeCloseTo(0.05, 10);
  });

  it("mid() is undefined when a side is missing", () => {
    const book = new LevelBook();
    book.apply(0.9, 5, "BUY");
    expect(book.mid()).toBeUndefined();
  });

  it("replace() clears the previous book (no cross-window leakage)", () => {
    const book = new LevelBook();
    book.replace(levels([[0.9, 5]]), "bids");
    book.replace(levels([[0.91, 5]]), "bids"); // snapshot replaces entirely
    expect(book.bestBid).toBe(0.91);
  });

  it("depth() sums the top N levels", () => {
    const book = new LevelBook();
    book.replace(
      levels([
        [0.95, 100],
        [0.94, 200],
        [0.93, 300],
        [0.92, 400],
      ]),
      "bids",
    );
    expect(book.depth(3, "bids")).toBe(600);
  });

  it("MarketState applies both bids and asks snapshot arrays symmetrically", () => {
    const state = new MarketState();
    state.applyPolymarketEvent({
      type: "book",
      timestampUtc: new Date().toISOString(),
      timestampMs: 1000,
      marketId: "0xcond",
      tokenId: "upToken",
      outcome: "UP",
      bidPrice: 0.52,
      askPrice: 0.54,
      bids: [
        { price: 0.52, size: 100 },
        { price: 0.51, size: 200 },
      ],
      asks: [
        { price: 0.54, size: 150 },
        { price: 0.55, size: 250 },
      ],
      source: "polymarket",
    });

    const side = state.sideSnapshot();
    expect(side.up.bid).toBe(0.52);
    expect(side.up.ask).toBe(0.54);
    expect(side.up.bidSize).toBe(100);
    expect(side.up.askSize).toBe(150);

    const snap = state.snapshot(1000, false);
    expect(snap.sequence).toBe(0); // sequence not incremented when incrementSequence is false
    const snap2 = state.snapshot(1000, true);
    expect(snap2.sequence).toBe(1); // incremented
  });
});