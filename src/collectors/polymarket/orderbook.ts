/**
 * Lightweight order-book model used to derive top-of-book + depth for the
 * snapshot engine. Levels are price->size maps applied from CLOB book snapshots
 * and price_change events. Replaced wholesale on every fresh `book` event, so
 * state cannot drift across reconnects.
 */

import type { PolymarketOrderBookLevel } from "../../types/market.js";

export interface BookTop {
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
}

export class LevelBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  /** Replaces the whole book (from a CLOB `book` snapshot message). */
  replace(levels: PolymarketOrderBookLevel[], side: "bids" | "asks"): void {
    const map = side === "bids" ? this.bids : this.asks;
    map.clear();
    for (const { price, size } of levels) {
      if (Number.isFinite(price) && price >= 0 && Number.isFinite(size) && size > 0) {
        map.set(price, size);
      }
    }
  }

  /** Applies one CLOB price_change. side "BUY" -> bid, "SELL" -> ask. */
  apply(price: number, size: number, side: "BUY" | "SELL"): void {
    const map = side === "BUY" ? this.bids : this.asks;
    if (size <= 0) {
      map.delete(price); // size 0 removes the level
    } else if (Number.isFinite(price) && price >= 0 && Number.isFinite(size)) {
      map.set(price, size);
    }
  }

  get bestBid(): number | undefined {
    if (this.bids.size === 0) return undefined;
    let best = -Infinity;
    for (const p of this.bids.keys()) if (p > best) best = p;
    return best;
  }

  get bestAsk(): number | undefined {
    if (this.asks.size === 0) return undefined;
    let best = Infinity;
    for (const p of this.asks.keys()) if (p < best) best = p;
    return best;
  }

  get bestBidSize(): number | undefined {
    const b = this.bestBid;
    return b === undefined ? undefined : this.bids.get(b);
  }

  get bestAskSize(): number | undefined {
    const a = this.bestAsk;
    return a === undefined ? undefined : this.asks.get(a);
  }

  /** Summed size across the top N price levels on a side. */
  depth(levels: number, side: "bids" | "asks"): number {
    const map = side === "bids" ? this.bids : this.asks;
    const sorted = side === "bids"
      ? [...map.entries()].sort((a, b) => b[0] - a[0])
      : [...map.entries()].sort((a, b) => a[0] - b[0]);
    let sum = 0;
    for (let i = 0; i < Math.min(levels, sorted.length); i += 1) {
      sum += sorted[i]?.[1] ?? 0;
    }
    return sum;
  }

  /** Top N levels as a stable array (for raw preservation / diagnostics). */
  snapshot(levels: number): { bids: PolymarketOrderBookLevel[]; asks: PolymarketOrderBookLevel[] } {
    const build = (map: Map<number, number>, desc: boolean) => {
      const sorted = desc
        ? [...map.entries()].sort((a, b) => b[0] - a[0])
        : [...map.entries()].sort((a, b) => a[0] - b[0]);
      return sorted.slice(0, levels).map(([price, size]) => ({ price, size }));
    };
    return {
      bids: build(this.bids, true),
      asks: build(this.asks, false),
    };
  }

  /** Midpoint if both sides available, else undefined. */
  mid(): number | undefined {
    const b = this.bestBid;
    const a = this.bestAsk;
    if (b === undefined || a === undefined) return undefined;
    return (b + a) / 2;
  }
}