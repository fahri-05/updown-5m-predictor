/**
 * Periodic runtime statistics — events/sec, snapshots/sec, current market,
 * last BTC price, side mids, connection status. Logs at STATS_INTERVAL_MS.
 */

import type { ExchangeHealth } from "../types/market.js";
import type { Logger } from "../utils/logger.js";
import type { MarketState } from "../engine/market-state.js";

export interface StatsDeps {
  logger: Logger;
  intervalMs: number;
  marketState: MarketState;
  getHealth: () => Record<string, ExchangeHealth>;
  getMarketSlug: () => string | null;
  getSamplesPerSec: () => number;
  getEventsPerSec: () => number;
  getSecondsRemaining: () => number | undefined;
}

export class Stats {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: StatsDeps) {}

  start(): void {
    this.timer = setInterval(() => this.report(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  report(): void {
    const snap = this.deps.marketState.snapshot();
    const health = this.deps.getHealth();
    const parts = [
      `events/s=${this.deps.getEventsPerSec()?.toFixed(1)}`,
      `snapshots/s=${this.deps.getSamplesPerSec()?.toFixed(1)}`,
      `market=${this.deps.getMarketSlug() ?? "none"}`,
      `secRemaining=${snap.market.secondsRemaining ?? "?"}`,
      `btc=${snap.btc.price ?? "?"}`,
      `chainlink=${snap.btc.chainlinkPrice ?? "?"}`,
      `upMid=${snap.polymarket.up.mid ?? "?"}`,
      `downMid=${snap.polymarket.down.mid ?? "?"}`,
    ];
    for (const [name, h] of Object.entries(health)) {
      parts.push(`${name}=${h.status}(reconnects:${h.reconnectCount})`);
    }
    this.deps.logger.info(`stats ${parts.join(" ")}`);
  }
}