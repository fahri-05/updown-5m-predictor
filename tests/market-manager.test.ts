import { describe, expect, it, vi } from "vitest";
import { MarketManager } from "../src/engine/market-manager.js";
import { MarketState } from "../src/engine/market-state.js";
import type { DiscoveredMarket } from "../src/types/market.js";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("silent");

const market = (windowStartMs: number, windowEndMs: number, slugTag: string): DiscoveredMarket => ({
  gammaMarketId: "1",
  gammaEventId: "1",
  slug: `btc-updown-5m-${slugTag}`,
  title: "",
  conditionId: `0x${slugTag}`,
  upTokenId: `up-${slugTag}`,
  downTokenId: `down-${slugTag}`,
  windowStartMs,
  windowEndMs,
  startTimeUtc: new Date(windowStartMs).toISOString(),
  endTimeUtc: new Date(windowEndMs).toISOString(),
  enableOrderBook: true,
});

describe("MarketManager", () => {
  it("discovers the active market and subscribes UP/DOWN tokens", async () => {
    const state = new MarketState();
    const feed = {
      setTokens: vi.fn().mockResolvedValue(undefined),
    } as unknown as { setTokens: ReturnType<typeof vi.fn> };
    const discovery = {
      findActive: vi.fn().mockResolvedValue(
        market(Date.UTC(2026, 8, 10, 14, 0), Date.UTC(2026, 8, 10, 14, 5), "1789052400"),
      ),
    };

    const mgr = new MarketManager({
      feed: feed as never,
      discovery: discovery as never,
      state,
      logger,
      windowSec: 300,
      presubscribeAheadMs: 30_000,
      graceMs: 15_000,
      pollMs: 60_000,
    });
    await mgr.start();
    expect(discovery.findActive).toHaveBeenCalledTimes(1);
    expect(feed.setTokens).toHaveBeenCalledWith("up-1789052400", "down-1789052400");
    expect(mgr.currentMarket?.conditionId).toBe("0x1789052400");
    await mgr.stop();
  });

  it("rolls over to the next market after the window expires (+ grace)", async () => {
    const state = new MarketState();
    const feed = {
      setTokens: vi.fn().mockResolvedValue(undefined),
    } as unknown as { setTokens: ReturnType<typeof vi.fn> };
    const first = market(Date.UTC(2026, 8, 10, 14, 0), Date.UTC(2026, 8, 10, 14, 5), "1789052400");
    const second = market(Date.UTC(2026, 8, 10, 14, 5), Date.UTC(2026, 8, 10, 14, 10), "1789052700");
    const discovery = {
      findActive: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    };

    const mgr = new MarketManager({
      feed: feed as never,
      discovery: discovery as never,
      state,
      logger,
      windowSec: 300,
      presubscribeAheadMs: 30_000,
      graceMs: 15_000,
      pollMs: 100, // short poll for the test
    });
    await mgr.start();
    expect(mgr.currentMarket?.conditionId).toBe("0x1789052400");

    // Fast-forward past the window end + grace: poll discovers the next market.
    await new Promise((r) => setTimeout(r, 50));
    // Use Math based date to trigger refresh as if time passed.
    await mgr.refresh({ rolloverIfExpired: true });
    expect(mgr.currentMarket?.conditionId).toBe("0x1789052700");
    expect(feed.setTokens).toHaveBeenLastCalledWith("up-1789052700", "down-1789052700");
    await mgr.stop();
  });
});