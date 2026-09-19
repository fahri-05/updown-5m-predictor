/**
 * BTC price-feed interface (adapter pattern).
 *
 * Feeds replaceable: Binance (v1) and Chainlink via Polymarket RTDS (v1,
 * optional). A new feed only needs to implement connect/disconnect/onEvent.
 */

import type { BtcMarketEvent, BtcSource, ExchangeHealth } from "../../types/market.js";

export interface BtcFeed {
  readonly source: BtcSource;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Subscribes a listener; returns an unsubscribe function. */
  onEvent(listener: (event: BtcMarketEvent) => void): () => void;
  health(): ExchangeHealth;
}

export interface MalformedHandler {
  /** Must be cheap; used to write unparseable frames to data/errors/. */
  onMalformed(raw: string, source: string, err: Error): void;
}

export interface BtcFeedDeps {
  url: string;
  symbol: string;
  logger: import("../../utils/logger.js").Logger;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  staleTimeoutMs: number;
  healthCheckIntervalMs: number;
  onMalformed?: MalformedHandler["onMalformed"];
}