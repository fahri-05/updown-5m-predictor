/**
 * Shared, strongly-typed market-data contracts for the updown-5m-predictor collector.
 *
 * All stored timestamps are UTC (ISO-8601) — see utils/time.ts.
 * The collector is strictly causal: a record may only contain information that
 * was available at or before its own timestamp.
 */

export type OutcomeSide = "UP" | "DOWN";
export type MarketOutcome = "UP" | "DOWN";

export type BtcSource = "binance" | "chainlink";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ExchangeHealth {
  status: ConnectionStatus;
  lastMessageTimestampMs: number | null;
  lastSuccessfulConnectionMs: number | null;
  reconnectCount: number;
}

/** A single normalized BTC market event recorded to data/raw/btc/*.jsonl */
export interface BtcMarketEvent {
  type: "trade" | "ticker" | "book";
  timestampUtc: string;
  timestampMs: number;
  symbol: string;

  price?: number;
  quantity?: number;

  bidPrice?: number;
  bidQuantity?: number;
  askPrice?: number;
  askQuantity?: number;

  source: BtcSource;
  /** Exchange/server-provided timestamp in ms, when the API exposes one. */
  exchangeTimestampMs?: number;
  /** Local receive timestamp in ms. Always set by the collector. */
  receivedTimestampMs: number;

  /** Order-book update id / sequence when the exchange provides one. */
  updateId?: number;
  /** Exchange trade id (Binance trade `t`). */
  tradeId?: number;
  /** Binance `m`: true when the buyer is the maker (aggressive seller). */
  isBuyerMaker?: boolean;
  /** Chainlink full-accuracy string when available (preserved verbatim). */
  fullAccuracyValue?: string;
  /** Chainlink/reference server receive timestamp in ms (RTDS top-level). */
  serverTimestampMs?: number;
}

export interface PolymarketOrderBookLevel {
  price: number;
  size: number;
}

/** A single normalized Polymarket event recorded to data/raw/polymarket/*.jsonl */
export interface PolymarketMarketEvent {
  type: "book" | "trade" | "ticker";
  timestampUtc: string;
  timestampMs: number;

  /** CLOB market channel identifier for this event (the condition id, 0x…). */
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcome: OutcomeSide;

  bidPrice?: number;
  askPrice?: number;
  bidSize?: number;
  askSize?: number;

  tradePrice?: number;
  tradeSize?: number;
  tradeSide?: "BUY" | "SELL";

  source: "polymarket";
  /** CLOB-provided message timestamp in ms. */
  exchangeTimestampMs?: number;
  receivedTimestampMs: number;

  /** Original CLOB channel event type. */
  eventType?: "book" | "price_change" | "last_trade_price" | "tick_size_change";
  transactionHash?: string;
  hash?: string | null;
  /** Market-level best bid/ask reported by the CLOB for price_change events. */
  bestBid?: number;
  bestAsk?: number;
  tickSize?: number;
  minOrderSize?: number;
  negRisk?: boolean;
  /** Full order-book levels on book events (preserved verbatim). */
  bids?: PolymarketOrderBookLevel[];
  asks?: PolymarketOrderBookLevel[];
}

/** Normalized snapshot written to data/snapshots/*.jsonl */
export interface MarketSnapshot {
  timestampUtc: string;
  timestampMs: number;

  market: {
    marketId: string;
    conditionId?: string;
    slug?: string;
    gammaMarketId?: string;
    startTimeUtc?: string;
    endTimeUtc?: string;
    startTimeMs?: number;
    endTimeMs?: number;
    secondsRemaining?: number;
  };

  btc: {
    price?: number;
    bid?: number;
    ask?: number;
    volume?: number;
    buyVolume?: number;
    sellVolume?: number;
    chainlinkPrice?: number;
  };

  polymarket: {
    up: PolymarketSideSnapshot;
    down: PolymarketSideSnapshot;
  };

  sequence?: number;
}

export interface PolymarketSideSnapshot {
  bid?: number;
  ask?: number;
  mid?: number;
  spread?: number;
  bidSize?: number;
  askSize?: number;
  lastTradePrice?: number;
}

/** A market discovered via the Polymarket Gamma REST API. */
export interface DiscoveredMarket {
  gammaMarketId: string;
  gammaEventId: string;
  slug: string;
  title: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  windowStartMs: number;
  windowEndMs: number;
  startTimeUtc: string;
  endTimeUtc: string;
  enableOrderBook?: boolean;
  resolutionSource?: string;
  description?: string;
}

/** Record written to data/errors/*.jsonl for unparseable upstream frames. */
export interface MalformedRecord {
  timestampUtc: string;
  timestampMs: number;
  source: string;
  error: string;
  raw?: unknown;
}