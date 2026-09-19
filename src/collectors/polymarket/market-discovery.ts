/**
 * Polymarket Gamma API market discovery for the BTC Up/Down 5m series.
 *
 * The recurring 5m series creates one market per 5-minute UTC window with
 * slug `btc-updown-5m-<windowStartUnix>`. Given a base window start (from an
 * optional slug override), the active market is resolved from
 *   GET /events?slug=btc-updown-5m-{ts}
 * which returns the event with its single market carrying:
 *   - markets[0].id            (Gamma market id)
 *   - markets[0].conditionId   (condition id, also the CLOB market channel id)
 *   - markets[0].clobTokenIds  [upTokenId, downTokenId] (outcomes ["Up","Down"])
 *   - markets[0].endDate       (window end)
 */

import type { DiscoveredMarket } from "../../types/market.js";
import { isoToMs, windowBucketMs } from "../../utils/time.js";
import type { Logger } from "../../utils/logger.js";

export interface MarketDiscoveryOptions {
  gammaBaseUrl: string;
  /** Window length in seconds (e.g. 5 * 60). */
  windowSec: number;
  /** Optional explicit slug override for the "event". */
  slugOverride?: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface GammaMarketRaw {
  id?: string | number;
  conditionId?: string;
  clobTokenIds?: string[] | string;
  outcomes?: string[] | string;
  slug?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  startDateIso?: string;
  endDateIso?: string;
  enableOrderBook?: boolean;
  resolutionSource?: string;
  description?: string;
}

interface GammaEventRaw {
  id?: string | number;
  slug?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  markets?: GammaMarketRaw[];
}

export { type GammaMarketRaw, type GammaEventRaw };

function parseStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // not a JSON array
    }
  }
  return [];
}

/**
 * Deterministic token side mapping from Gamma market fields. Index order of
 * clobTokenIds matches outcomes ["Up","Down"], so index 0 -> UP, 1 -> DOWN.
 */
export function sideTokensFromGamma(
  market: GammaMarketRaw,
): {
  upTokenId: string | null;
  downTokenId: string | null;
} {
  const tokens = parseStringArray(market.clobTokenIds);
  const rawOutcomes = parseStringArray(market.outcomes);
  const outcomes = rawOutcomes.length > 0 ? rawOutcomes : tokens;
  const upIndex = outcomes.findIndex((o) => o.toLowerCase().includes("up"));
  const downIndex = outcomes.findIndex((o) => o.toLowerCase().includes("down"));
  const upTokenId = upIndex >= 0 ? (tokens[upIndex] ?? null) : tokens[0] ?? null;
  const downTokenId = downIndex >= 0 ? (tokens[downIndex] ?? null) : tokens[1] ?? null;
  return { upTokenId, downTokenId };
}
/**
 * Converts a Gamma event into a DiscoveredMarket. Throws a descriptive error
 * when token ids or dates are missing/malformed — never silently invents values.
 */
export function eventToDiscoveredMarket(ev: GammaEventRaw, windowSec: number): DiscoveredMarket {
  const market = ev.markets?.[0];
  if (!market) throw new Error(`event ${ev.slug ?? ev.id} has no markets`);
  const { upTokenId, downTokenId } = sideTokensFromGamma(market);
  if (!market.conditionId) throw new Error(`market ${market.slug ?? market.id} missing conditionId`);
  if (!upTokenId || !downTokenId) {
    throw new Error(
      `market ${market.slug ?? market.id} missing clobTokenIds / Up-Down tokens (got ${JSON.stringify(market.clobTokenIds)})`,
    );
  }

  const slug = market.slug ?? ev.slug ?? "";
  const endIso = market.endDate ?? ev.endDate ?? market.endDateIso;
  if (!endIso) throw new Error(`market ${slug || market.id} missing endDate`);

  const windowMs = windowSec * 1000;
  let endMs: number;
  let bucketStart: number;

  if (endIso.includes("T")) {
    endMs = isoToMs(endIso);
    bucketStart = windowBucketMs(endMs - 1, windowMs);
  } else if (slug) {
    try {
      bucketStart = parseSlugTs(slug, windowMs);
      endMs = bucketStart + windowMs;
    } catch {
      endMs = isoToMs(endIso);
      bucketStart = windowBucketMs(endMs - 1, windowMs);
    }
  } else {
    endMs = isoToMs(endIso);
    bucketStart = windowBucketMs(endMs - 1, windowMs);
  }

  const startIso = market.startDate ?? market.startDateIso ?? new Date(bucketStart).toISOString();
  const startMs = startIso.includes("T") ? isoToMs(startIso) : bucketStart;

  return {
    gammaMarketId: String(market.id ?? ev.id ?? ""),
    gammaEventId: String(ev.id ?? ""),
    slug: market.slug ?? ev.slug ?? "",
    title: market.title ?? ev.title ?? "",
    conditionId: market.conditionId,
    upTokenId,
    downTokenId,
    windowStartMs: bucketStart,
    windowEndMs: endMs,
    startTimeUtc: new Date(startMs).toISOString(),
    endTimeUtc: new Date(endMs).toISOString(),
    enableOrderBook: market.enableOrderBook,
    resolutionSource: market.resolutionSource,
    description: market.description,
  };
}

/** Parses the trailing Unix-seconds timestamp from a slug like btc-updown-5m-1789052400. */
export function parseSlugTs(slug: string, windowMs: number): number {
  const m = /-(\d{9,11})$/.exec(slug.trim());
  if (!m?.[1]) throw new Error(`slug has no trailing window timestamp: ${slug}`);
  const sec = Number(m[1]);
  if (!Number.isFinite(sec)) throw new Error(`slug window timestamp not numeric: ${slug}`);
  return windowBucketMs(sec * 1000, windowMs);
}

export class MarketDiscovery {
  private opts: Required<Pick<MarketDiscoveryOptions, "gammaBaseUrl" | "windowSec" | "logger">> &
    Pick<MarketDiscoveryOptions, "slugOverride"> & {
      fetchImpl: typeof fetch;
    };

  constructor(options: MarketDiscoveryOptions) {
    this.opts = {
      gammaBaseUrl: options.gammaBaseUrl,
      windowSec: options.windowSec,
      slugOverride: options.slugOverride ?? undefined,
      logger: options.logger,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  /**
   * Finds the market active at `atMs`. Resolves the base window start from the
   * slug override (if configured), else the current UTC window. Returns null
   * when the specific event no longer exists in Gamma.
   */
  async findActive(atMs: number): Promise<DiscoveredMarket | null> {
    const windowMs = this.opts.windowSec * 1000;
    const baseStart = this.opts.slugOverride
      ? parseSlugTs(this.opts.slugOverride, windowMs)
      : windowBucketMs(atMs, windowMs);
    const slug = `btc-updown-5m-${baseStart / 1000}`;
    const url = `${this.opts.gammaBaseUrl}/events?slug=${encodeURIComponent(slug)}`;
    this.opts.logger.info(`discovering market: ${url}`);

    let res: Response;
    try {
      res = await this.opts.fetchImpl(url);
    } catch (err) {
      throw new Error(`market discovery request failed: ${String(err)}`);
    }
    if (!res.ok) {
      throw new Error(`market discovery HTTP ${res.status} for slug ${slug}`);
    }

    const body = (await res.json()) as GammaEventRaw[] | { error?: string };
    if (!Array.isArray(body)) {
      throw new Error(
        `market discovery unexpected body for slug ${slug}: ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    if (body.length === 0) return null;
    if (body.length > 1) {
      this.opts.logger.warn(`multiple markets matched slug ${slug}; using the first`);
    }

    return eventToDiscoveredMarket(body[0] as GammaEventRaw, this.opts.windowSec);
  }
}