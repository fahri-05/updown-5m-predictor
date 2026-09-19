/**
 * MarketState — the causal "latest known state" of BTC + Polymarket.
 *
 * Feeds push into it; the SnapshotEngine reads from it. Only fields that are
 * available at time T are present — no future info is ever injected.
 * Bounded memory: scalar fields + order-book maps only (no unbounded arrays).
 */

import type {
  BtcMarketEvent,
  MarketSnapshot,
  PolymarketMarketEvent,
  PolymarketSideSnapshot,
} from "../types/market.js";
import { LevelBook } from "../collectors/polymarket/orderbook.js";
import { isoUtc, nowMs } from "../utils/time.js";

export interface MarketMeta {
  marketId: string;
  conditionId?: string;
  slug?: string;
  gammaMarketId?: string;
  windowStartMs?: number;
  windowEndMs?: number;
  startTimeUtc?: string;
  endTimeUtc?: string;
}

export class MarketState {
  private btcPrice: number | undefined;
  private btcBid: number | undefined;
  private btcAsk: number | undefined;
  private btcVolume: number | undefined;
  private btcBuyVolume: number | undefined;
  private btcSellVolume: number | undefined;
  private chainlinkPrice: number | undefined;

  private upBook = new LevelBook();
  private downBook = new LevelBook();
  private upLastTrade: number | undefined;
  private downLastTrade: number | undefined;

  private meta: MarketMeta | null = null;
  private sequence = 0;

  applyBtcEvent(event: BtcMarketEvent): void {
    if (event.source === "chainlink") {
      if (event.price !== undefined) this.chainlinkPrice = event.price;
      return;
    }
    if (event.type === "trade") {
      if (event.price !== undefined) this.btcPrice = event.price;
      if (event.quantity !== undefined) {
        this.btcVolume = (this.btcVolume ?? 0) + event.quantity;
        if (event.isBuyerMaker === false) {
          // Binance m=false => aggressive buyer.
          this.btcBuyVolume = (this.btcBuyVolume ?? 0) + event.quantity;
        } else if (event.isBuyerMaker === true) {
          this.btcSellVolume = (this.btcSellVolume ?? 0) + event.quantity;
        }
      }
    } else if (event.type === "book" || event.type === "ticker") {
      if (event.bidPrice !== undefined) this.btcBid = event.bidPrice;
      if (event.askPrice !== undefined) this.btcAsk = event.askPrice;
      if (event.price !== undefined) this.btcPrice = event.price;
    }
  }

  applyPolymarketEvent(event: PolymarketMarketEvent): void {
    if (event.outcome === "UP") {
      if (event.type === "trade") {
        if (event.tradePrice !== undefined) this.upLastTrade = event.tradePrice;
      } else {
        if (event.bidPrice !== undefined || event.askPrice !== undefined) {
          if (event.bidPrice !== undefined) this.upBook.apply(event.bidPrice, event.bidSize ?? 0, "BUY");
          if (event.askPrice !== undefined) this.upBook.apply(event.askPrice, event.askSize ?? 0, "SELL");
        } else if (Array.isArray(event.bids)) {
          this.upBook.replace(event.bids, "bids");
        }
        if (Array.isArray(event.asks)) this.upBook.replace(event.asks, "asks");
      }
    } else if (event.outcome === "DOWN") {
      if (event.type === "trade") {
        if (event.tradePrice !== undefined) this.downLastTrade = event.tradePrice;
      } else {
        if (event.bidPrice !== undefined || event.askPrice !== undefined) {
          if (event.bidPrice !== undefined) this.downBook.apply(event.bidPrice, event.bidSize ?? 0, "BUY");
          if (event.askPrice !== undefined) this.downBook.apply(event.askPrice, event.askSize ?? 0, "SELL");
        } else if (Array.isArray(event.bids)) {
          this.downBook.replace(event.bids, "bids");
        }
        if (Array.isArray(event.asks)) this.downBook.replace(event.asks, "asks");
      }
    }
  }

  setMarketMeta(meta: MarketMeta): void {
    this.meta = meta;
    // A new window should not inherit the previous window's book/price state,
    // but BTC price continuity is kept (the BTC feed is continuous).
    this.upBook = new LevelBook();
    this.downBook = new LevelBook();
    this.upLastTrade = undefined;
    this.downLastTrade = undefined;
  }

  sideSnapshot(): {
    up: PolymarketSideSnapshot;
    down: PolymarketSideSnapshot;
  } {
    const upBid = this.upBook.bestBid;
    const upAsk = this.upBook.bestAsk;
    const downBid = this.downBook.bestBid;
    const downAsk = this.downBook.bestAsk;
    return {
      up: {
        bid: upBid,
        ask: upAsk,
        mid: midOf(upBid, upAsk),
        spread: spreadOf(upBid, upAsk),
        bidSize: this.upBook.bestBidSize,
        askSize: this.upBook.bestAskSize,
        lastTradePrice: this.upLastTrade,
      },
      down: {
        bid: downBid,
        ask: downAsk,
        mid: midOf(downBid, downAsk),
        spread: spreadOf(downBid, downAsk),
        bidSize: this.downBook.bestBidSize,
        askSize: this.downBook.bestAskSize,
        lastTradePrice: this.downLastTrade,
      },
    };
  }

  snapshot(now: number = nowMs()): MarketSnapshot {
    const side = this.sideSnapshot();
    const windowEnd = this.meta?.windowEndMs;
    const secondsRemaining =
      windowEnd !== undefined ? Math.max(0, Math.floor((windowEnd - now) / 1000)) : undefined;
    this.sequence += 1;
    return {
      timestampUtc: isoUtc(now),
      timestampMs: now,
      market: {
        marketId: this.meta?.marketId ?? "",
        conditionId: this.meta?.conditionId,
        slug: this.meta?.slug,
        gammaMarketId: this.meta?.gammaMarketId,
        startTimeUtc: this.meta?.startTimeUtc,
        endTimeUtc: this.meta?.endTimeUtc,
        startTimeMs: this.meta?.windowStartMs,
        endTimeMs: this.meta?.windowEndMs,
        secondsRemaining,
      },
      btc: {
        price: this.btcPrice,
        bid: this.btcBid,
        ask: this.btcAsk,
        volume: this.btcVolume,
        buyVolume: this.btcBuyVolume,
        sellVolume: this.btcSellVolume,
        chainlinkPrice: this.chainlinkPrice,
      },
      polymarket: {
        up: side.up,
        down: side.down,
      },
      sequence: this.sequence,
    };
  }

  getBtcPrice(): number | undefined {
    return this.btcPrice;
  }

  hasMarketMeta(): boolean {
    return this.meta !== null;
  }
}

function midOf(bid: number | undefined, ask: number | undefined): number | undefined {
  if (bid === undefined || ask === undefined) return undefined;
  return round6((bid + ask) / 2);
}

function spreadOf(bid: number | undefined, ask: number | undefined): number | undefined {
  if (bid === undefined || ask === undefined) return undefined;
  return round6(ask - bid);
}

/** Rounds to 6 decimals to avoid float noise in stored midpoint/spread values. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}