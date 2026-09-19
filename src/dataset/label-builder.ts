/**
 * LabelBuilder — determines the binary target label for a 5-minute Polymarket window.
 *
 * Polymarket Resolution Rule:
 *  - Resolves to "UP" (target = 1) if the reference BTC price (Chainlink) at the
 *    end of the window >= price at the beginning of that window.
 *  - Otherwise resolves to "DOWN" (target = 0).
 *  - Resolution source: Chainlink BTC/USD streams (with Binance BTC fallback when
 *    Chainlink stream is unavailable).
 */

import type { MarketSnapshot, BtcMarketEvent } from "../types/market.js";

export interface WindowLabelInput {
  slug: string;
  windowStartMs: number;
  windowEndMs: number;
  snapshots?: MarketSnapshot[];
  btcEvents?: BtcMarketEvent[];
  /** Optional Gamma event/market metadata if querying resolved historical markets */
  gammaEventMetadata?: {
    finalPrice?: number;
    priceToBeat?: number;
    umaResolutionStatus?: string;
    outcomePrices?: string[] | string;
    outcomes?: string[] | string;
  };
}

export interface WindowLabel {
  slug: string;
  windowStartMs: number;
  windowEndMs: number;
  label: "UP" | "DOWN";
  target: 1 | 0;
  startPrice: number;
  endPrice: number;
  priceDiff: number;
  priceChangePct: number;
  ruleId: "chainlink_resolution" | "chainlink_start_end" | "binance_start_end";
}

export interface LabelBuilder {
  buildLabel(input: WindowLabelInput): WindowLabel;
}

export class ResolutionLabelBuilder implements LabelBuilder {
  buildLabel(input: WindowLabelInput): WindowLabel {
    const { slug, windowStartMs, windowEndMs, snapshots, gammaEventMetadata } = input;

    // 1. Direct Polymarket Gamma settlement metadata if available
    if (gammaEventMetadata) {
      if (
        typeof gammaEventMetadata.finalPrice === "number" &&
        typeof gammaEventMetadata.priceToBeat === "number"
      ) {
        const startPrice = gammaEventMetadata.priceToBeat;
        const endPrice = gammaEventMetadata.finalPrice;
        const isUp = endPrice >= startPrice;
        const priceDiff = endPrice - startPrice;
        return {
          slug,
          windowStartMs,
          windowEndMs,
          label: isUp ? "UP" : "DOWN",
          target: isUp ? 1 : 0,
          startPrice,
          endPrice,
          priceDiff,
          priceChangePct: startPrice > 0 ? (priceDiff / startPrice) * 100 : 0,
          ruleId: "chainlink_resolution",
        };
      }
    }

    // 2. Resolve from snapshots recorded by the collector
    if (snapshots && snapshots.length > 0) {
      return this.resolveFromSnapshots(input);
    }

    // 3. Resolve from raw BTC events if provided
    if (input.btcEvents && input.btcEvents.length > 0) {
      return this.resolveFromEvents(input);
    }

    throw new Error(`cannot build label for window ${slug}: no snapshots, events, or metadata provided`);
  }

  private resolveFromSnapshots(input: WindowLabelInput): WindowLabel {
    const { slug, windowStartMs, windowEndMs, snapshots = [] } = input;

    // Separate Chainlink vs Binance prices
    let startClPrice: number | undefined;
    let startClDist = Infinity;
    let endClPrice: number | undefined;
    let endClDist = Infinity;

    let startBtcPrice: number | undefined;
    let startBtcDist = Infinity;
    let endBtcPrice: number | undefined;
    let endBtcDist = Infinity;

    for (const snap of snapshots) {
      const ts = snap.timestampMs;
      const cl = snap.btc.chainlinkPrice;
      const btc = snap.btc.price ?? snap.btc.bid ?? snap.btc.ask;

      const distStart = Math.abs(ts - windowStartMs);
      const distEnd = Math.abs(ts - windowEndMs);

      if (cl !== undefined && cl > 0) {
        if (distStart < startClDist) {
          startClDist = distStart;
          startClPrice = cl;
        }
        if (distEnd < endClDist) {
          endClDist = distEnd;
          endClPrice = cl;
        }
      }

      if (btc !== undefined && btc > 0) {
        if (distStart < startBtcDist) {
          startBtcDist = distStart;
          startBtcPrice = btc;
        }
        if (distEnd < endBtcDist) {
          endBtcDist = distEnd;
          endBtcPrice = btc;
        }
      }
    }

    // Prefer Chainlink (resolution source) if available at both boundaries
    if (startClPrice !== undefined && endClPrice !== undefined) {
      const isUp = endClPrice >= startClPrice;
      const priceDiff = endClPrice - startClPrice;
      return {
        slug,
        windowStartMs,
        windowEndMs,
        label: isUp ? "UP" : "DOWN",
        target: isUp ? 1 : 0,
        startPrice: startClPrice,
        endPrice: endClPrice,
        priceDiff,
        priceChangePct: startClPrice > 0 ? (priceDiff / startClPrice) * 100 : 0,
        ruleId: "chainlink_start_end",
      };
    }

    // Fallback to Binance spot BTC price
    if (startBtcPrice !== undefined && endBtcPrice !== undefined) {
      const isUp = endBtcPrice >= startBtcPrice;
      const priceDiff = endBtcPrice - startBtcPrice;
      return {
        slug,
        windowStartMs,
        windowEndMs,
        label: isUp ? "UP" : "DOWN",
        target: isUp ? 1 : 0,
        startPrice: startBtcPrice,
        endPrice: endBtcPrice,
        priceDiff,
        priceChangePct: startBtcPrice > 0 ? (priceDiff / startBtcPrice) * 100 : 0,
        ruleId: "binance_start_end",
      };
    }

    throw new Error(`insufficient price data to compute resolution label for window ${slug}`);
  }

  private resolveFromEvents(input: WindowLabelInput): WindowLabel {
    const { slug, windowStartMs, windowEndMs, btcEvents = [] } = input;

    let startPrice: number | undefined;
    let startDist = Infinity;
    let endPrice: number | undefined;
    let endDist = Infinity;
    let ruleId: "chainlink_start_end" | "binance_start_end" = "chainlink_start_end";

    // Chainlink first
    const clEvents = btcEvents.filter((e) => e.source === "chainlink" && e.price !== undefined);
    const targetEvents = clEvents.length >= 2 ? clEvents : btcEvents.filter((e) => e.price !== undefined);

    if (targetEvents !== clEvents) {
      ruleId = "binance_start_end";
    }

    for (const e of targetEvents) {
      const ts = e.timestampMs;
      const p = e.price!;
      const distStart = Math.abs(ts - windowStartMs);
      const distEnd = Math.abs(ts - windowEndMs);

      if (distStart < startDist) {
        startDist = distStart;
        startPrice = p;
      }
      if (distEnd < endDist) {
        endDist = distEnd;
        endPrice = p;
      }
    }

    if (startPrice === undefined || endPrice === undefined) {
      throw new Error(`cannot resolve boundaries for window ${slug} from raw events`);
    }

    const isUp = endPrice >= startPrice;
    const priceDiff = endPrice - startPrice;
    return {
      slug,
      windowStartMs,
      windowEndMs,
      label: isUp ? "UP" : "DOWN",
      target: isUp ? 1 : 0,
      startPrice,
      endPrice,
      priceDiff,
      priceChangePct: (priceDiff / startPrice) * 100,
      ruleId,
    };
  }
}