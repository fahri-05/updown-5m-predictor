/**
 * Chainlink BTC/USD feed via Polymarket's public RTDS WebSocket
 * (wss://ws-live-data.polymarket.com), topic crypto_prices_chainlink.
 *
 * This is the resolution-relevant reference price for the BTC Up/Down 5m
 * markets, so it is recorded as a second BTC reference feed (adapter pattern).
 * It is optional and independent of the Binance feed.
 */

import { isoUtc } from "../../utils/time.js";
import { ReconnectingSocket } from "../../utils/reconnecting-socket.js";
import type { BtcMarketEvent, ExchangeHealth } from "../../types/market.js";
import type { BtcFeed, BtcFeedDeps } from "./btc-feed.js";

interface ChainlinkPricePayload {
  symbol: string;
  value: number;
  full_accuracy_value?: string;
  timestamp: number; // data timestamp ms (Chainlink aggregate time)
}

interface ChainlinkUpdateMessage {
  topic: string;
  type: string;
  timestamp?: number; // server receive time ms
  payload?: ChainlinkPricePayload;
  connection_id?: string;
  error?: string;
  message?: string;
}

export class ChainlinkFeed implements BtcFeed {
  readonly source = "chainlink" as const;
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
      pingMessage: () => "PING",
      pingIntervalMs: 5000,
      onOpen: () => this.subscribe(),
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

  async connect(): Promise<void> {
    await this.socket.connect();
  }

  async disconnect(): Promise<void> {
    await this.socket.disconnect();
  }

  private emit(event: BtcMarketEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Resubscribes on every (re)connect — single subscription per connection. */
  private subscribe(): void {
    this.socket.sendText(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          { topic: "crypto_prices_chainlink", type: "update", filters: `{"symbol":"${this.deps.symbol.toLowerCase()}/usd"}` },
        ],
      }),
    );
    this.deps.logger.info(`Chainlink subscription sent for ${this.deps.symbol}/usd`);
  }

  private onRawMessage(raw: string, receivedMs: number): void {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "PONG" || trimmed === "PING") {
      return;
    }
    let msg: ChainlinkUpdateMessage;
    try {
      msg = JSON.parse(raw) as ChainlinkUpdateMessage;
    } catch (err) {
      this.deps.onMalformed?.(raw, `chainlink:${this.deps.symbol}`, err as Error);
      return;
    }
    if (msg.topic !== "crypto_prices_chainlink" || msg.type !== "update") {
      return; // ack/keepalive/other topics are not market data
    }
    const payload = msg.payload;
    if (!payload || typeof payload.value !== "number" || typeof payload.timestamp !== "number") {
      this.deps.onMalformed?.(raw, `chainlink:${this.deps.symbol}`, new Error("malformed chainlink payload"));
      return;
    }
    this.emit({
      type: "ticker",
      timestampUtc: isoUtc(payload.timestamp),
      timestampMs: payload.timestamp,
      symbol: `${this.deps.symbol}/usd`,
      price: payload.value,
      source: "chainlink",
      exchangeTimestampMs: payload.timestamp,
      receivedTimestampMs: receivedMs,
      serverTimestampMs: msg.timestamp,
      fullAccuracyValue: payload.full_accuracy_value,
    });
  }
}