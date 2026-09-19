/**
 * updown-5m-predictor collector entrypoint.
 *
 * Wires config -> storage -> feeds -> market state -> snapshot engine -> stats,
 * and handles SIGINT/SIGTERM graceful shutdown:
 *   - closes WebSockets gracefully
 *   - flushes buffered JSONL
 *   - closes all file handles
 *
 * This is a research DATA COLLECTOR ONLY — it never places trades.
 */

import { loadConfig } from "./config/config.js";
import { createLogger } from "./utils/logger.js";
import { BufferedJsonlWriter } from "./storage/jsonl-writer.js";
import { ErrorWriter } from "./storage/error-writer.js";
import { BinanceFeed } from "./collectors/btc/binance-feed.js";
import { ChainlinkFeed } from "./collectors/btc/chainlink-feed.js";
import { PolymarketFeed } from "./collectors/polymarket/polymarket-feed.js";
import { MarketDiscovery } from "./collectors/polymarket/market-discovery.js";
import { MarketState } from "./engine/market-state.js";
import { MarketManager } from "./engine/market-manager.js";
import { SnapshotEngine } from "./engine/snapshot-engine.js";
import { Stats } from "./engine/stats.js";
import { validateBtcEvent, validatePolymarketEvent, describeIssues } from "./utils/validation.js";

import type { ExchangeHealth } from "./types/market.js";

export async function runCollector(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel as never);

  // ---- Storage -----------------------------------------------------------------
  const btcWriter = new BufferedJsonlWriter(config.dataDir, "btc", logger);
  const pmWriter = new BufferedJsonlWriter(config.dataDir, "polymarket", logger);
  const snapshotWriter = new BufferedJsonlWriter(config.dataDir, "snapshots", logger);
  const errorWriter = new BufferedJsonlWriter(config.dataDir, "errors", logger);
  const malformed = new ErrorWriter({ writer: errorWriter, logger });

  // ---- State -------------------------------------------------------------------
  const marketState = new MarketState();

  // ---- Feeds -------------------------------------------------------------------
  const feeds: Array<{
    name: string;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    health(): import("./types/market.js").ExchangeHealth;
  }> = [];

  if (config.binanceEnabled) {
    const binance = new BinanceFeed({
      url: config.binanceWsUrl,
      symbol: config.binanceSymbol,
      logger: logger.child("binance"),
      reconnectInitialDelayMs: config.reconnectInitialDelayMs,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs,
      staleTimeoutMs: config.staleTimeoutMs,
      healthCheckIntervalMs: config.healthCheckIntervalMs,
      onMalformed: (raw, src, err) => malformed.handle(raw, src, err),
    });
    binance.onEvent((e) => {
      for (const issue of describeIssues(validateBtcEvent(e))) logger.debug(issue);
      eventCount += 1;
      void btcWriter.append(e, e.timestampMs);
      marketState.applyBtcEvent(e);
    });
    feeds.push({
      name: "binance",
      connect: () => binance.connect(),
      disconnect: () => binance.disconnect(),
      health: () => binance.health(),
    });
  }
if (config.chainlinkEnabled) {
    const chainlink = new ChainlinkFeed({
      url: config.polymarketRtdsUrl,
      symbol: "btc",
      logger: logger.child("chainlink"),
      reconnectInitialDelayMs: config.reconnectInitialDelayMs,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs,
      staleTimeoutMs: config.staleTimeoutMs,
      healthCheckIntervalMs: config.healthCheckIntervalMs,
      onMalformed: (raw, src, err) => malformed.handle(raw, src, err),
    });
    chainlink.onEvent((e) => {
      eventCount += 1;
      void btcWriter.append(e, e.timestampMs);
      marketState.applyBtcEvent(e);
    });
    feeds.push({
      name: "chainlink",
      connect: () => chainlink.connect(),
      disconnect: () => chainlink.disconnect(),
      health: () => chainlink.health(),
    });
  }

  let pmFeed: PolymarketFeed | null = null;
  if (config.polymarketEnabled) {
    pmFeed = new PolymarketFeed({
      url: config.polymarketWsUrl,
      logger: logger.child("polymarket"),
      reconnectInitialDelayMs: config.reconnectInitialDelayMs,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs,
      staleTimeoutMs: config.staleTimeoutMs,
      healthCheckIntervalMs: config.healthCheckIntervalMs,
      upTokenId: config.polymarketUpTokenId ?? "0",
      downTokenId: config.polymarketDownTokenId ?? "0",
      onMalformed: (raw, src, err) => malformed.handle(raw, src, err),
    });
    pmFeed.onEvent((e) => {
      for (const issue of describeIssues(validatePolymarketEvent(e))) logger.debug(issue);
      eventCount += 1;
      void pmWriter.append(e, e.timestampMs);
      marketState.applyPolymarketEvent(e);
    });
  }

  // ---- Snapshot engine ----------------------------------------------------------
  const snapshotEngine = new SnapshotEngine({
    intervalMs: config.snapshotIntervalMs,
    marketState,
    writer: snapshotWriter,
    logger: logger.child("snapshots"),
  });

  // ---- Periodic flush ------------------------------------------------------------
  const flushTimer = setInterval(() => {
    void btcWriter.flush();
    void pmWriter.flush();
    void snapshotWriter.flush();
    void errorWriter.flush();
  }, config.flushIntervalMs);
  flushTimer.unref?.();
// ---- Stats -----------------------------------------------------------------------
  let eventCount = 0;
  const stats = new Stats({
    logger: logger.child("stats"),
    intervalMs: config.statsIntervalMs,
    marketState,
    getHealth: () => {
      const h: Record<string, ExchangeHealth> = {};
      for (const feed of feeds) h[feed.name] = feed.health();
      if (pmFeed) h.polymarket = pmFeed.health();
      return h;
    },
    getMarketSlug: () => (marketManager ? marketManager.currentMarket?.slug ?? null : null),
    getSamplesPerSec: () => snapshotEngine.getSamples() / Math.max(1, config.statsIntervalMs / 1000),
    getEventsPerSec: () => eventCount / Math.max(1, config.statsIntervalMs / 1000),
    getSecondsRemaining: () => {
      const m = marketManager?.currentMarket;
      if (!m) return undefined;
      return Math.max(0, Math.floor((m.windowEndMs - Date.now()) / 1000));
    },
  });

  // ---- Market manager -----------------------------------------------------------------
  let marketManager: MarketManager | null = null;
  if (pmFeed && config.polymarketEnabled) {
    const discovery = new MarketDiscovery({
      gammaBaseUrl: config.gammaBaseUrl,
      windowSec: config.marketWindowSec,
      slugOverride: config.polymarketMarketSlug,
      logger: logger.child("discovery"),
    });
    marketManager = new MarketManager({
      feed: pmFeed,
      discovery,
      state: marketState,
      logger: logger.child("market"),
      windowSec: config.marketWindowSec,
      presubscribeAheadMs: config.presubscribeAheadMs,
      graceMs: config.marketUnsubGraceMs,
      pollMs: config.discoveryPollMs,
    });
  }

  // ---- Startup ------------------------------------------------------------------------
  logger.info("Starting updown-5m-predictor collector (research data collection only — no trading)");
  for (const feed of feeds) {
    try {
      await feed.connect();
    } catch (err) {
      logger.error(`feed ${feed.name} initial connect failed: ${String(err)}`);
    }
  }
  if (marketManager) await marketManager.start();
  snapshotEngine.start();
  stats.start();

  // ---- Shutdown --------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal} — shutting down gracefully`);
    try {
      clearInterval(flushTimer);
      snapshotEngine.stop();
      stats.stop();
      if (marketManager) await marketManager.stop();
      for (const feed of feeds) {
        try {
          await feed.disconnect();
        } catch (err) {
          logger.error(`feed ${feed.name} disconnect error: ${String(err)}`);
        }
      }
      if (pmFeed) {
        try {
          await pmFeed.disconnect();
        } catch (err) {
          logger.error(`polymarket disconnect error: ${String(err)}`);
        }
      }
      await Promise.all([
        btcWriter.flush(),
        pmWriter.flush(),
        snapshotWriter.flush(),
        errorWriter.flush(),
      ]);
      await Promise.all([
        btcWriter.close(),
        pmWriter.close(),
        snapshotWriter.close(),
        errorWriter.close(),
      ]);
    } catch (err) {
      logger.error(`shutdown error: ${String(err)}`);
    }
    logger.info("shutdown complete");
    process.exitCode = 0;
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Entry guard: only run as the main module (not when imported by tests/CLI).
const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMainModule) {
  runCollector().catch((err) => {
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exitCode = 1;
  });
}