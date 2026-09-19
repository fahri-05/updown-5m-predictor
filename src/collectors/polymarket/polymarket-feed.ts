/**
 * Polymarket CLOB market-channel WebSocket feed.
 *
 * Protocol (verified against live endpoints):
 *  - endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *  - subscribe: {"assets_ids":[...token ids...],"type":"market"}
 *  - keepalive: send text "PING" -> server replies "PONG"
 *  - events: book (array of per-token snapshots), price_change
 *    (includes best_bid/best_ask), last_trade_price, tick_size_change
 *
 * Every frame is normalized into PolymarketMarketEvent records; unparseable
 * frames are handed to the malformed handler (data/errors/). Raw fields are
 * preserved (full level arrays, hashes, transaction hashes, exchange ts).
 */

import type {
  ExchangeHealth,
  OutcomeSide,
  PolymarketMarketEvent,
  PolymarketOrderBookLevel,
} from "../../types/market.js";
import { isoUtc } from "../../utils/time.js";
import { ReconnectingSocket } from "../../utils/reconnecting-socket.js";
import type { Logger } from "../../utils/logger.js";

export interface PolymarketFeedDeps {
  url: string;
  logger: Logger;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  staleTimeoutMs: number;
  healthCheckIntervalMs: number;
  upTokenId: string;
  downTokenId: string;
  onMalformed: (raw: string, source: string, err: Error) => void;
}

interface ClobLevel {
  price?: string;
  size?: string;
  [k: string]: unknown;
}

interface ClobBookElement {
  market?: string;
  asset_id?: string;
  bids?: ClobLevel[];
  asks?: ClobLevel[];
  hash?: string | null;
  timestamp?: string | null;
}

interface ClobPriceChange {
  asset_id?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
  hash?: string | null;
  best_bid?: string | null;
  best_ask?: string | null;
  [k: string]: unknown;
}

interface ClobMessageObject {
  market?: string;
  event_type?: string;
  timestamp?: string | null;
  price_changes?: ClobPriceChange[];
  asset_id?: string;
  price?: string;
  size?: string;
  side?: "BUY" | "SELL";
  transaction_hash?: string;
  hash?: string | null;
  tick_size?: string;
  min_order_size?: string;
  neg_risk?: boolean;
  [k: string]: unknown;
}

interface ClobMessage {
  [k: string]: unknown;
}

export class PolymarketFeed {
  private socket: ReconnectingSocket;
  private listeners: Array<(event: PolymarketMarketEvent) => void> = [];
  private upTokenId: string;
  private downTokenId: string;

  constructor(private readonly deps: PolymarketFeedDeps) {
    this.upTokenId = deps.upTokenId;
    this.downTokenId = deps.downTokenId;
    this.socket = new ReconnectingSocket({
      url: deps.url,
      logger: deps.logger,
      reconnectInitialDelayMs: deps.reconnectInitialDelayMs,
      reconnectMaxDelayMs: deps.reconnectMaxDelayMs,
      staleTimeoutMs: deps.staleTimeoutMs,
      healthCheckIntervalMs: deps.healthCheckIntervalMs,
      pingMessage: () => "PING",
      pingIntervalMs: 5000,
      onOpen: () => this.subscribe(),
      onMessage: (raw, receivedMs) => this.onRawMessage(raw, receivedMs),
    });
  }

  onEvent(listener: (event: PolymarketMarketEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  health(): ExchangeHealth {
    return this.socket.health();
  }

  async connect(): Promise<void> {
    await this.socket.connect();
  }

  async disconnect(): Promise<void> {
    await this.socket.disconnect();
  }

  /**
   * Swaps the subscribed tokens (market rollover). Reconnects to obtain a fresh
   * book snapshot for the new tokens. Ensures the socket is connected even when
   * the tokens were seeded from an explicit config.
   */
  async setTokens(upTokenId: string, downTokenId: string): Promise<void> {
    if (upTokenId === this.upTokenId && downTokenId === this.downTokenId) {
      if (!this.socket.isOpen) await this.socket.connect();
      return;
    }
    this.upTokenId = upTokenId;
    this.downTokenId = downTokenId;
    this.deps.logger.info("Polymarket feed token set changed — reconnecting");
    if (this.socket.isOpen) await this.socket.disconnect();
    await this.socket.connect();
  }

  private subscribe(): void {
    const sent = this.socket.sendText(
      JSON.stringify({ assets_ids: [this.upTokenId, this.downTokenId], type: "market" }),
    );
    if (sent) {
      this.deps.logger.info(
        `Polymarket subscription sent (${this.upTokenId.slice(0, 8)}…, ${this.downTokenId.slice(0, 8)}…)`,
      );
    }
  }

  private emit(event: PolymarketMarketEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private outcomeForToken(tokenId: string): OutcomeSide | null {
    if (tokenId === this.upTokenId) return "UP";
    if (tokenId === this.downTokenId) return "DOWN";
    return null;
  }

  private onRawMessage(raw: string, receivedMs: number): void {
    let parsed: ClobMessage | ClobBookElement[];
    try {
      parsed = JSON.parse(raw) as ClobMessage | ClobBookElement[];
    } catch (err) {
      // CLOB keepalive replies are not JSON ("PONG") — ignore those, report others.
      const trimmed = raw.trim();
      if (trimmed !== "PONG" && trimmed !== "PING") {
        this.deps.onMalformed(raw, "polymarket", err as Error);
      }
      return;
    }

    if (Array.isArray(parsed)) {
      for (const el of parsed as ClobBookElement[]) {
        if (Array.isArray(el.bids) && Array.isArray(el.asks)) {
          this.handleBook(el, receivedMs);
        }
      }
      return;
    }

    const msg = parsed as ClobMessageObject;
    if (msg.event_type === "price_change") {
      this.handlePriceChange(msg, receivedMs);
      return;
    }
    if (msg.event_type === "last_trade_price") {
      this.handleTrade(msg, receivedMs);
      return;
    }
    if (msg.event_type === "tick_size_change") {
      this.handleTickSize(msg, receivedMs);
      return;
    }
    // Unknown/non-data frames (pong, ack) are deliberately ignored.
  }

  private msgTimestampMs(msg: { timestamp?: string | null }, receivedMs: number): number {
    const t = msg?.timestamp;
    if (typeof t === "string" && t !== "") {
      const n = Number(t);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return receivedMs;
  }

  private handleBook(el: ClobBookElement, receivedMs: number): void {
    const tokenId = el.asset_id as string;
    const outcome = this.outcomeForToken(tokenId);
    if (!outcome) return; // token no longer tracked (previous market window)
    const tsMs = this.msgTimestampMs(el, receivedMs);
    const bids = (el.bids ?? []).map(this.toLevel).filter(Boolean) as PolymarketOrderBookLevel[];
    const asks = (el.asks ?? []).map(this.toLevel).filter(Boolean) as PolymarketOrderBookLevel[];
    const topBid = maxPrice(bids);
    const topAsk = minPrice(asks);

    this.emit({
      type: "book",
      timestampUtc: isoUtc(tsMs),
      timestampMs: tsMs,
      marketId: (el.market as string) ?? "",
      conditionId: el.market as string,
      tokenId,
      outcome,
      bidPrice: topBid ?? undefined,
      bidSize: sizeAtPrice(bids, topBid),
      askPrice: topAsk ?? undefined,
      askSize: sizeAtPrice(asks, topAsk),
      source: "polymarket",
      exchangeTimestampMs: el.timestamp ? tsMs : undefined,
      receivedTimestampMs: receivedMs,
      eventType: "book",
      hash: el.hash ?? undefined,
      bids,
      asks,
    });
  }
private handlePriceChange(msg: ClobMessageObject, receivedMs: number): void {
    const tsMs = this.msgTimestampMs(msg, receivedMs);
    if (!Array.isArray(msg.price_changes)) return;
    for (const change of msg.price_changes) {
      const tokenId = change.asset_id as string;
      const outcome = this.outcomeForToken(tokenId);
      if (!outcome) continue; // stale token from a previous market window
      const price = Number(change.price);
      const size = Number(change.size);
      const isBid = change.side === "BUY";
      this.emit({
        type: "book",
        timestampUtc: isoUtc(tsMs),
        timestampMs: tsMs,
        marketId: (msg.market as string) ?? "",
        conditionId: msg.market as string,
        tokenId,
        outcome,
        bidPrice: isBid ? price : undefined,
        bidSize: isBid ? size : undefined,
        askPrice: isBid ? undefined : price,
        askSize: isBid ? undefined : size,
        bestBid: numOrUndefined(change.best_bid),
        bestAsk: numOrUndefined(change.best_ask),
        source: "polymarket",
        exchangeTimestampMs: msg.timestamp ? tsMs : undefined,
        receivedTimestampMs: receivedMs,
        eventType: "price_change",
        hash: change.hash ?? undefined,
      });
    }
  }

  private handleTrade(msg: ClobMessageObject, receivedMs: number): void {
    const tokenId = msg.asset_id as string;
    const outcome = this.outcomeForToken(tokenId);
    if (!outcome) return; // stale token
    const tsMs = this.msgTimestampMs(msg, receivedMs);
    this.emit({
      type: "trade",
      timestampUtc: isoUtc(tsMs),
      timestampMs: tsMs,
      marketId: (msg.market as string) ?? "",
      conditionId: msg.market as string,
      tokenId,
      outcome,
      tradePrice: Number(msg.price),
      tradeSize: Number(msg.size),
      tradeSide: msg.side === "SELL" ? "SELL" : "BUY",
      source: "polymarket",
      exchangeTimestampMs: msg.timestamp ? tsMs : undefined,
      receivedTimestampMs: receivedMs,
      eventType: "last_trade_price",
      transactionHash: msg.transaction_hash,
    });
  }

  private handleTickSize(msg: ClobMessageObject, receivedMs: number): void {
    const tokenId = msg.asset_id as string;
    const outcome = this.outcomeForToken(tokenId);
    if (!outcome) return; // stale token
    const tsMs = this.msgTimestampMs(msg, receivedMs);
    this.emit({
      type: "ticker",
      timestampUtc: isoUtc(tsMs),
      timestampMs: tsMs,
      marketId: msg.market as string,
      conditionId: msg.market as string,
      tokenId,
      outcome,
      tickSize: Number(msg.tick_size),
      minOrderSize: Number(msg.min_order_size),
      negRisk: msg.neg_risk,
      source: "polymarket",
      exchangeTimestampMs: msg.timestamp ? tsMs : undefined,
      receivedTimestampMs: receivedMs,
      eventType: "tick_size_change",
    });
  }

  private toLevel(level: ClobLevel): PolymarketOrderBookLevel | null {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    return { price, size };
  }
}

function numOrUndefined(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function maxPrice(levels: PolymarketOrderBookLevel[]): number | undefined {
  let best = -Infinity;
  for (const l of levels) if (l.price > best) best = l.price;
  return best === -Infinity ? undefined : best;
}

function minPrice(levels: PolymarketOrderBookLevel[]): number | undefined {
  let best = Infinity;
  for (const l of levels) if (l.price < best) best = l.price;
  return best === Infinity ? undefined : best;
}

function sizeAtPrice(levels: PolymarketOrderBookLevel[], price: number | undefined): number | undefined {
  if (price === undefined) return undefined;
  const l = levels.find((x) => x.price === price);
  return l?.size;
}