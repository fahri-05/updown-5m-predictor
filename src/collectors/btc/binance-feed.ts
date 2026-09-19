/**
 * Binance BTCUSDT feed — trade stream + book ticker stream via one combined
 * WebSocket URL. Uses the adapter interface in btc-feed.ts.
 */

import type { BtcMarketEvent, ExchangeHealth } from "../../types/market.js";
import { isoUtc } from "../../utils/time.js";
import { ReconnectingSocket } from "../../utils/reconnecting-socket.js";
import type { BtcFeed, BtcFeedDeps } from "./btc-feed.js";

interface BinanceTradeRaw {
  e: string;
  E: number; // event time ms
  T: number; // trade time ms
  s: string;
  p: string;
  q: string;
  t: number; // trade id
  b?: string;
  a?: string;
  m: boolean; // is buyer maker
  M?: boolean;
}

interface BinanceBookTickerRaw {
  u: number; // order book update id
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

interface BinanceCombinedFrame {
  stream: string;
  data: unknown;
}

export class BinanceFeed implements BtcFeed {
  readonly source = "binance" as const;
  private socket: ReconnectingSocket;
  private listeners: Array<(event: BtcMarketEvent) => void> = [];

  constructor(private readonly deps: BtcFeedDeps) {
    this.socket = new ReconnectingSocket({
      url: deps.url,
      logger: deps.logger,
      reconnectInitialDelayMs: deps.reconnectInitialDelayMs,
      reconnectMaxDelayMs: deps.reconnectMaxDelayMs,
      staleTimeoutMs: deps.staleTimeoutMs,
      healthCheckIntervalMs: deps.healthCheckIntervalMs,
      onMessage: (raw, receivedMs) => this.onRawMessage(raw, receivedMs),
    });
  }

  onEvent(listener: (event: BtcMarketEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  health(): ExchangeHealth {
    return this.socket.health();
  }

  connect(): Promise<void> {
    return this.socket.connect();
  }

  disconnect(): Promise<void> {
    return this.socket.disconnect();
  }

  private emit(event: BtcMarketEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private onRawMessage(raw: string, receivedMs: number): void {
    let frame: BinanceCombinedFrame;
    try {
      frame = JSON.parse(raw) as BinanceCombinedFrame;
    } catch (err) {
      this.deps.onMalformed?.(raw, `binance:${this.deps.symbol}`, err as Error);
      return;
    }
    if (!frame || typeof frame.stream !== "string") {
      this.deps.onMalformed?.(raw, `binance:${this.deps.symbol}`, new Error("missing stream field"));
      return;
    }

    if (frame.stream === `${this.deps.symbol.toLowerCase()}@trade`) {
      const e = frame.data as BinanceTradeRaw;
      if (!e || typeof e.T !== "number" || typeof e.p !== "string") {
        this.deps.onMalformed?.(raw, `binance:${this.deps.symbol}`, new Error("malformed trade payload"));
        return;
      }
      const price = Number(e.p);
      const quantity = Number(e.q);
      if (!Number.isFinite(price) || !Number.isFinite(quantity)) {
        this.deps.onMalformed?.(raw, `binance:${this.deps.symbol}`, new Error(`bad trade numerics p=${e.p} q=${e.q}`));
        return;
      }
      this.emit({
        type: "trade",
        timestampUtc: isoUtc(e.T),
        timestampMs: e.T,
        symbol: e.s ?? this.deps.symbol,
        price,
        quantity,
        source: "binance",
        exchangeTimestampMs: e.T,
        receivedTimestampMs: receivedMs,
        tradeId: e.t,
        isBuyerMaker: e.m,
      });
      return;
    }

    if (frame.stream === `${this.deps.symbol.toLowerCase()}@bookTicker`) {
      const e = frame.data as BinanceBookTickerRaw;
      if (!e || typeof e.b !== "string" || typeof e.a !== "string") {
        this.deps.onMalformed?.(raw, `binance:${this.deps.symbol}`, new Error("malformed bookTicker payload"));
        return;
      }
      const bidPrice = Number(e.b);
      const bidQuantity = Number(e.B);
      const askPrice = Number(e.a);
      const askQuantity = Number(e.A);
      this.emit({
        type: "book",
        timestampUtc: isoUtc(receivedMs), // bookTicker has no exchange timestamp
        timestampMs: receivedMs,
        symbol: e.s ?? this.deps.symbol,
        bidPrice,
        bidQuantity,
        askPrice,
        askQuantity,
        source: "binance",
        receivedTimestampMs: receivedMs,
        updateId: e.u,
      });
      return;
    }

    this.deps.logger.debug(`unhandled binance stream: ${frame.stream}`);
  }
}