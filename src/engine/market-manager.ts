/**
 * MarketManager — owns the lifecycle of the active BTC Up/Down 5m market:
 * discovery, subscription, rollover to the next window, and clean teardown.
 *
 * Flow:
 *   1. findActive(current time) -> gamma metadata (UP/DOWN token ids, window)
 *   2. PolymarketFeed.setTokens(upTokenId, downTokenId) -> subscribe
 *   3. MarketState.setMarketMeta -> snapshots carry the market envelope
 *   4. at windowEndMs: "Market expired" -> discover next market -> subscribe
 *
 * Market discovery is dynamic — never hard-coded token ids. The CLOB `book`
 * snapshot is re-delivered on every (re)subscribe, so switching subscriptions
 * at the window boundary loses no order-book state.
 */

import type { PolymarketFeed } from "../collectors/polymarket/polymarket-feed.js";
import { MarketDiscovery } from "../collectors/polymarket/market-discovery.js";
import type { DiscoveredMarket } from "../types/market.js";
import type { Logger } from "../utils/logger.js";
import type { MarketState } from "../engine/market-state.js";

export interface MarketManagerDeps {
  feed: PolymarketFeed;
  discovery: MarketDiscovery;
  state: MarketState;
  logger: Logger;
  windowSec: number;
  presubscribeAheadMs: number;
  graceMs: number;
  pollMs: number;
}

export class MarketManager {
  private current: DiscoveredMarket | null = null;
  private nextTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: MarketManagerDeps) {}

  get currentMarket(): DiscoveredMarket | null {
    return this.current;
  }

  /** Initial discovery + subscription. Retries briefly; the poll keeps retrying. */
  async start(): Promise<void> {
    this.stopped = false;
    const first = await this.discoverWithRetry(5);
    if (first) await this.activate(first);
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.nextTimer) clearTimeout(this.nextTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.nextTimer = null;
    this.pollTimer = null;
    if (this.current) this.deps.logger.info("Market manager stopped");
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.pollTimer = setInterval(() => {
      void this.refresh({ rolloverIfExpired: true });
    }, this.deps.pollMs);
    this.pollTimer.unref?.();
  }

  /** Keeps the market subscription current; discovers the next window when due. */
  async refresh(opts?: { rolloverIfExpired?: boolean }): Promise<void> {
    const now = Date.now();

    // Arm the rollover timer for the current market's boundary.
    if (this.current && this.nextTimer === null && this.current.windowEndMs > now) {
      this.scheduleRollover(this.current.windowEndMs - now);
    }

    const needsDiscovery =
      this.current === null ||
      (opts?.rolloverIfExpired === true && now >= this.current.windowEndMs);

    if (!needsDiscovery) return;

    try {
      const found = await this.deps.discovery.findActive(now);
      if (found && found.conditionId !== this.current?.conditionId) {
        if (this.current && now >= this.current.windowEndMs) {
          this.deps.logger.info(
            `Market expired (${this.current.slug}) — subscribing next market`,
          );
        }
        await this.activate(found);
      } else if (!found && this.current) {
        this.deps.logger.warn("Market window ended — next market not yet listed; will retry");
      }
    } catch (err) {
      this.deps.logger.error(`market discovery failed: ${String(err)}`);
    }
  }

  private scheduleRollover(delayMs: number): void {
    if (this.stopped || this.nextTimer) return;
    this.deps.logger.info(
      `Market expires in ~${Math.max(1, Math.round(delayMs / 1000))}s; rollover armed`,
    );
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      void this.refresh({ rolloverIfExpired: true });
    }, delayMs);
    this.nextTimer.unref?.();
  }

  private async discoverWithRetry(maxAttempts: number): Promise<DiscoveredMarket | null> {
    let delay = 1000;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (this.stopped) return null;
      try {
        const m = await this.deps.discovery.findActive(Date.now());
        if (!m) {
          this.deps.logger.warn("No active BTC Up/Down 5m market found; retrying…");
        } else {
          return m;
        }
      } catch (err) {
        this.deps.logger.warn(`discovery error, retrying in ${delay}ms: ${String(err)}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, this.deps.pollMs * 2);
    }
    return null;
  }

  private async activate(market: DiscoveredMarket): Promise<void> {
    this.current = market;
    await this.deps.state.setMarketMeta({
      marketId: market.conditionId,
      conditionId: market.conditionId,
      slug: market.slug,
      gammaMarketId: market.gammaMarketId,
      windowStartMs: market.windowStartMs,
      windowEndMs: market.windowEndMs,
      startTimeUtc: market.startTimeUtc,
      endTimeUtc: market.endTimeUtc,
    });
    // Subscribe the feed (setTokens reconnects only when tokens change).
    await this.deps.feed.setTokens(market.upTokenId, market.downTokenId);
    this.deps.logger.info(
      `BTC market discovered: ${market.slug} | UP ${market.upTokenId.slice(0, 10)}… | DOWN ${market.downTokenId.slice(0, 10)}… | end=${market.endTimeUtc}`,
    );
    this.deps.logger.info(
      `Market window ${market.windowStartMs}→${market.windowEndMs} (up token subscribed, down token subscribed)`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}