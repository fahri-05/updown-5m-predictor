import { describe, expect, it, vi } from "vitest";
import {
  MarketDiscovery,
  eventToDiscoveredMarket,
  parseSlugTs,
  sideTokensFromGamma,
} from "../src/collectors/polymarket/market-discovery.js";
import type { GammaEventRaw } from "../src/collectors/polymarket/market-discovery.js";
import { createLogger } from "../src/utils/logger.js";

const BASE_ENDBUCKET = Date.UTC(2026, 8, 10, 14, 0, 0, 0); // market window start 14:00
const BASE_END = Date.UTC(2026, 8, 10, 14, 5, 0, 0); // window end 14:05

// Note: the slug timestamp IS the window start (14:00), and Gamma endDate is
// exactly windowStart + 300s (14:05) — same contract as the live API.
const gammaEvent = (over: Partial<GammaEventRaw> = {}): GammaEventRaw => ({
  id: "42",
  slug: "btc-updown-5m-1789052400",
  markets: [
    {
      id: 1,
      conditionId: "0xcond",
      clobTokenIds: ["uptoken", "downtoken"],
      outcomes: ["Up", "Down"],
      endDateIso: new Date(BASE_END).toISOString(),
      startDateIso: new Date(BASE_ENDBUCKET).toISOString(),
      enableOrderBook: true,
    },
  ],
  ...over,
});

describe("sideTokensFromGamma", () => {
  it("identifies UP and DOWN tokens by outcome order", () => {
    const side = sideTokensFromGamma({
      clobTokenIds: ["uptoken", "downtoken"],
      outcomes: ["Up", "Down"],
    });
    expect(side.upTokenId).toBe("uptoken");
    expect(side.downTokenId).toBe("downtoken");
  });

  it("falls back to token order when outcomes are absent", () => {
    const side = sideTokensFromGamma({ clobTokenIds: ["a", "b"] });
    expect(side.upTokenId).toBe("a");
    expect(side.downTokenId).toBe("b");
  });

  it("identifies UP and DOWN tokens from JSON-stringified arrays (live Gamma API format)", () => {
    const side = sideTokensFromGamma({
      clobTokenIds: '["uptoken123", "downtoken456"]',
      outcomes: '["Up", "Down"]',
    });
    expect(side.upTokenId).toBe("uptoken123");
    expect(side.downTokenId).toBe("downtoken456");
  });

  it("returns nulls when tokens are missing (never invents)", () => {
    const side = sideTokensFromGamma({});
    expect(side.upTokenId).toBeNull();
    expect(side.downTokenId).toBeNull();
  });
});

describe("eventToDiscoveredMarket", () => {
  it("maps a Gamma event into DiscoveredMarket metadata", () => {
    const m = eventToDiscoveredMarket(gammaEvent(), 300);
    expect(m.conditionId).toBe("0xcond");
    expect(m.upTokenId).toBe("uptoken");
    expect(m.downTokenId).toBe("downtoken");
    expect(m.windowStartMs).toBe(BASE_ENDBUCKET);
    expect(m.windowEndMs).toBe(BASE_END);
    expect(m.slug).toBe("btc-updown-5m-1789052400");
  });

  it("throws on a market missing conditionId", () => {
    expect(() =>
      eventToDiscoveredMarket(
        gammaEvent({ markets: [{ id: 1, clobTokenIds: ["a", "b"] }] }),
        300,
      ),
    ).toThrow(/conditionId/);
  });

  it("throws on a market missing token ids", () => {
    expect(() =>
      eventToDiscoveredMarket(
        gammaEvent({
          markets: [{ id: 1, conditionId: "0x", clobTokenIds: [], endDateIso: new Date(BASE_END).toISOString() }],
        }),
        300,
      ),
    ).toThrow(/clobTokenIds/);
  });
});

describe("parseSlugTs", () => {
  it("extracts the window timestamp from a slug", () => {
    expect(parseSlugTs("btc-updown-5m-1789052400", 300_000)).toBe(1_789_052_400_000);
  });
  it("throws on a slug without a timestamp", () => {
    expect(() => parseSlugTs("btc-updown-5m", 300_000)).toThrow();
  });
});

describe("MarketDiscovery", () => {
  it("queries the active market and detects expiration (null)", async () => {
    const activeCall = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([gammaEvent()]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const discovery = new MarketDiscovery({
      gammaBaseUrl: "http://gamma",
      windowSec: 300,
      logger: createLogger("silent"),
      fetchImpl: activeCall,
    });
    const found = await discovery.findActive(BASE_ENDBUCKET + 123);
    expect(found?.upTokenId).toBe("uptoken");
    expect(found?.conditionId).toBe("0xcond");

    // Simulate the event being removed after the window closes.
    const expiredCall = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const discovery2 = new MarketDiscovery({
      gammaBaseUrl: "http://gamma",
      windowSec: 300,
      logger: createLogger("silent"),
      fetchImpl: expiredCall,
    });
    const expired = await discovery2.findActive(BASE_END + 60_000);
    expect(expired).toBeNull();
  });

  it("uses the slugOverride base for window discovery", async () => {
    const call = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([gammaEvent()]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const discovery = new MarketDiscovery({
      gammaBaseUrl: "http://gamma",
      windowSec: 300,
      slugOverride: "btc-updown-5m-1789052400",
      logger: createLogger("silent"),
      fetchImpl: call,
    });
    await discovery.findActive(BASE_ENDBUCKET + 123);
    expect(String(call.mock.calls[0]?.[0]).includes("slug=btc-updown-5m-1789052400")).toBe(true);
  });

  it("throws on HTTP failure (surfaced to the caller, logged)", async () => {
    const discovery = new MarketDiscovery({
      gammaBaseUrl: "http://gamma",
      windowSec: 300,
      logger: createLogger("silent"),
      fetchImpl: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    });
    await expect(discovery.findActive(BASE_ENDBUCKET)).rejects.toThrow(/HTTP 500/);
  });
});