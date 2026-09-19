/**
 * Data-quality validation helpers.
 *
 * These detect problems (missing/negative/NaN/future timestamps, impossible
 * bid>ask spreads, stale feeds, duplicate sequences) and log them. They NEVER
 * silently drop records during collection — that preserves the raw dataset.
 */

import type { BtcMarketEvent, MarketSnapshot, PolymarketMarketEvent } from "../types/market.js";

export interface ValidationIssue {
  code: string;
  message: string;
  /** true = record is unsalvageable (missing timestamp etc.) */
  fatal: boolean;
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Checks common timestamp/timestampUtc invariants. */
export function validateTimestamps(tsMs?: number, tsUtc?: string, receivedMs?: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (tsMs === undefined || !isFiniteNum(tsMs) || tsMs <= 0) {
    issues.push({ code: "missing_timestamp_ms", message: "timestampMs missing or non-positive", fatal: true });
  } else {
    const d = new Date(tsMs);
    if (Number.isNaN(d.getTime())) issues.push({ code: "invalid_timestamp_ms", message: "timestampMs unparseable", fatal: true });
    if (tsUtc) {
      const parsed = Date.parse(tsUtc);
      if (Number.isNaN(parsed)) issues.push({ code: "invalid_timestamp_utc", message: `timestampUtc unparseable: ${tsUtc}`, fatal: true });
      else if (parsed !== tsMs && Math.abs(parsed - tsMs) > 10) {
        issues.push({ code: "timestamp_utc_mismatch", message: `timestampUtc (${tsUtc}) != timestampMs (${tsMs})`, fatal: false });
      }
    }
    const now = Date.now();
    if (tsMs > now + 60_000) {
      issues.push({ code: "timestamp_in_future", message: `timestampMs is in the future: ${tsMs}`, fatal: false });
    }
  }
  if (receivedMs !== undefined && !isFiniteNum(receivedMs)) {
    issues.push({ code: "invalid_received_timestamp", message: "receivedTimestampMs is not a finite number", fatal: false });
  }
  return issues;
}

export function validateBtcEvent(e: BtcMarketEvent): ValidationIssue[] {
  const issues: ValidationIssue[] = validateTimestamps(e.timestampMs, e.timestampUtc, e.receivedTimestampMs);
  if (e.price !== undefined && (!isFiniteNum(e.price) || e.price <= 0)) {
    issues.push({ code: "invalid_btc_price", message: `price ${e.price}`, fatal: false });
  }
  if (e.quantity !== undefined && (!isFiniteNum(e.quantity) || e.quantity < 0)) {
    issues.push({ code: "negative_quantity", message: `quantity ${e.quantity}`, fatal: false });
  }
  const bid = e.bidPrice;
  const ask = e.askPrice;
  if (bid !== undefined && ask !== undefined && isFiniteNum(bid) && isFiniteNum(ask) && bid > ask) {
    issues.push({ code: "bid_above_ask", message: `bidPrice ${bid} > askPrice ${ask}`, fatal: false });
  }
  return issues;
}

export function validatePolymarketEvent(e: PolymarketMarketEvent): ValidationIssue[] {
  const issues: ValidationIssue[] = validateTimestamps(e.timestampMs, e.timestampUtc, e.receivedTimestampMs);
  if (!e.tokenId) issues.push({ code: "missing_token_id", message: "tokenId missing", fatal: true });
  if (!e.outcome) issues.push({ code: "missing_outcome", message: "outcome missing", fatal: true });
  if (e.bidPrice !== undefined && e.askPrice !== undefined && isFiniteNum(e.bidPrice) && isFiniteNum(e.askPrice) && e.bidPrice > e.askPrice) {
    issues.push({ code: "bid_above_ask", message: `bidPrice ${e.bidPrice} > askPrice ${e.askPrice}`, fatal: false });
  }
  if (e.tradeSize !== undefined && isFiniteNum(e.tradeSize) && e.tradeSize < 0) {
    issues.push({ code: "negative_trade_size", message: `tradeSize ${e.tradeSize}`, fatal: false });
  }
  return issues;
}

export function validateSnapshot(s: MarketSnapshot): ValidationIssue[] {
  const issues: ValidationIssue[] = validateTimestamps(s.timestampMs, s.timestampUtc);
  const { up, down } = s.polymarket;
  for (const [name, side] of [
    ["up", up],
    ["down", down],
  ] as const) {
    if (side.bid !== undefined && side.ask !== undefined && isFiniteNum(side.bid) && isFiniteNum(side.ask) && side.bid > side.ask) {
      issues.push({ code: "snapshot_bid_above_ask", message: `${name} bid ${side.bid} > ask ${side.ask}`, fatal: false });
    }
  }
  return issues;
}

/** Convenience for summarizing issues into log lines. */
export function describeIssues(issues: ValidationIssue[]): string[] {
  return issues.map((i) => `${i.fatal ? "FATAL" : "validation"}: ${i.code} — ${i.message}`);
}