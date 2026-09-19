/**
 * Typed configuration loaded from environment variables (.env).
 * Public endpoints require no authentication — no API keys are invented.
 */

import "dotenv/config";

export interface AppConfig {
  snapshotIntervalMs: number;
  dataDir: string;
  logLevel: string;

  polymarketEnabled: boolean;
  binanceEnabled: boolean;
  chainlinkEnabled: boolean;

  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;

  staleTimeoutMs: number;
  healthCheckIntervalMs: number;

  marketWindowSec: number;
  discoveryPollMs: number;
  presubscribeAheadMs: number;
  marketUnsubGraceMs: number;

  // optional explicit overrides (empty = auto-discovery)
  polymarketMarketSlug?: string;
  polymarketUpTokenId?: string;
  polymarketDownTokenId?: string;
  polymarketConditionId?: string;

  gammaBaseUrl: string;
  polymarketWsUrl: string;
  polymarketRtdsUrl: string;
  binanceWsUrl: string;
  binanceSymbol: string;

  flushIntervalMs: number;
  statsIntervalMs: number;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function str(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === "" ? fallback : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    snapshotIntervalMs: Math.max(50, num(env, "SNAPSHOT_INTERVAL_MS", 250)),
    dataDir: str(env, "DATA_DIR", "./data"),
    logLevel: str(env, "LOG_LEVEL", "info"),

    polymarketEnabled: bool(env, "POLYMARKET_ENABLED", true),
    binanceEnabled: bool(env, "BINANCE_ENABLED", true),
    chainlinkEnabled: bool(env, "CHAINLINK_ENABLED", true),

    reconnectInitialDelayMs: num(env, "RECONNECT_INITIAL_DELAY_MS", 1000),
    reconnectMaxDelayMs: num(env, "RECONNECT_MAX_DELAY_MS", 30000),

    staleTimeoutMs: num(env, "STALE_TIMEOUT_MS", 60000),
    healthCheckIntervalMs: Math.max(500, num(env, "HEALTH_CHECK_INTERVAL_MS", 5000)),

    marketWindowSec: num(env, "MARKET_WINDOW_SEC", 300),
    discoveryPollMs: Math.max(1000, num(env, "DISCOVERY_POLL_MS", 5000)),
    presubscribeAheadMs: Math.max(0, num(env, "PRESUBSCRIBE_AHEAD_MS", 30000)),
    marketUnsubGraceMs: Math.max(0, num(env, "MARKET_UNSUB_GRACE_MS", 15000)),

    polymarketMarketSlug: env.POLYMARKET_MARKET_SLUG || undefined,
    polymarketUpTokenId: env.POLYMARKET_UP_TOKEN_ID || undefined,
    polymarketDownTokenId: env.POLYMARKET_DOWN_TOKEN_ID || undefined,
    polymarketConditionId: env.POLYMARKET_CONDITION_ID || undefined,

    gammaBaseUrl: str(env, "GAMMA_BASE_URL", "https://gamma-api.polymarket.com"),
    polymarketWsUrl: str(env, "POLYMARKET_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
    polymarketRtdsUrl: str(env, "POLYMARKET_RTDS_URL", "wss://ws-live-data.polymarket.com"),
    binanceWsUrl: str(env, "BINANCE_WS_URL", "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@bookTicker"),
    binanceSymbol: str(env, "BINANCE_SYMBOL", "BTCUSDT"),

    flushIntervalMs: Math.max(100, num(env, "FLUSH_INTERVAL_MS", 1000)),
    statsIntervalMs: Math.max(1000, num(env, "STATS_INTERVAL_MS", 30000)),
  };
}