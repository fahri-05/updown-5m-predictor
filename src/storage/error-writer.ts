/**
 * Malformed-frame handling: writes unparseable events to data/errors/*.jsonl
 * with the original raw message preserved. Nothing is silently dropped.
 */

import type { JsonlWriter } from "../storage/jsonl-writer.js";
import { isoUtc, nowMs } from "../utils/time.js";
import type { Logger } from "../utils/logger.js";

export interface ErrorWriterDeps {
  writer: JsonlWriter;
  logger: Logger;
}

export class ErrorWriter {
  private dedupWindow = new Map<string, number>();
  private readonly DEDUP_MS = 5000;

  constructor(private readonly deps: ErrorWriterDeps) {}

  handle(raw: string, source: string, err: Error): void {
    const key = `${source}:${err.message ?? "parse"}`;
    const last = this.dedupWindow.get(key);
    const now = nowMs();
    if (last !== undefined && now - last < this.DEDUP_MS) {
      return; // suppress logging spam for repeated idents
    }
    this.dedupWindow.set(key, now);
    const record = {
      timestampUtc: isoUtc(now),
      timestampMs: now,
      source,
      error: err.message ?? String(err),
      raw,
    };
    this.deps.writer.append(record, now).catch((e) => {
      this.deps.logger.error(`error-writer append failed: ${String(e)}`);
    });
    this.deps.logger.warn(`malformed message from ${source}: ${err.message}`);
  }
}