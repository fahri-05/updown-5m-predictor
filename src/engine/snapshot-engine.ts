/**
 * SnapshotEngine — periodically samples MarketState into normalized
 * MarketSnapshot records and writes them to JSONL.
 *
 * Strictly causal: a snapshot only contains state that was known by/near the
 * sample time. Cadence is configurable (default 250ms). Writes are
 * backpressure-aware (serialized via the JsonlWriter queue).
 */

import type { JsonlWriter } from "../storage/jsonl-writer.js";
import type { Logger } from "../utils/logger.js";
import type { MarketState } from "./market-state.js";

export interface SnapshotEngineDeps {
  intervalMs: number;
  marketState: MarketState;
  writer: JsonlWriter;
  logger: Logger;
  statTimerMs?: number;
}

export class SnapshotEngine {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private samples = 0;
  private lastTickAtMs = 0;

  constructor(private readonly deps: SnapshotEngineDeps) {}

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => {
      this.tick();
    }, this.deps.intervalMs);
    this.timer.unref?.();
    this.deps.logger.info(`Snapshot engine started (every ${this.deps.intervalMs}ms)`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deps.logger.info("Snapshot engine stopped");
  }

  async flush(): Promise<void> {
    await this.deps.writer.flush();
  }

  async close(): Promise<void> {
    this.stop();
    await this.deps.writer.close();
  }

  getSamples(): number {
    return this.samples;
  }

  private tick(): void {
    if (this.stopped) return;
    const snapshot = this.deps.marketState.snapshot();
    this.samples += 1;
    this.lastTickAtMs = snapshot.timestampMs;
    // append() is synchronous enqueue into a bounded queue; never blocks the loop.
    this.deps.writer.append(snapshot, snapshot.timestampMs).catch((err) => {
      this.deps.logger.error(`snapshot append failed: ${String(err)}`);
    });
  }
}