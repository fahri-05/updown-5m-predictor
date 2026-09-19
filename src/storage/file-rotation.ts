/**
 * JSONL file-rotation helpers.
 * Raw event files rotate by UTC date/hour:
 *   data/<category>/YYYY-MM-DD/HH.jsonl
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { utcDateKey, utcHourKey } from "../utils/time.js";

export type RecordCategory = "btc" | "polymarket" | "snapshots" | "errors";

/** Absolute path to the hourly JSONL file that should contain tsMs. */
export function recordPath(baseDir: string, category: RecordCategory, tsMs: number): string {
  const key = utcHourKey(tsMs);
  return join(baseDir, category, key + ".jsonl");
}

/** Absolute path to the JSONL file that should contain tsMs, without creating dirs. */
export function snapshotPathForDate(baseDir: string, category: RecordCategory, tsMs: number): string {
  return recordPath(baseDir, category, tsMs);
}

/**
 * Repairs the tail of an existing JSONL file after an unclean shutdown: if the
 * final line has no trailing newline it is a partial write and gets truncated.
 */
export async function salvageJsonlTail(filePath: string): Promise<void> {
  const { stat, open } = await import("node:fs/promises");
  try {
    const st = await stat(filePath);
    if (st.size === 0) return;
    const CHUNK = 8192;
    const fd = await open(filePath, "r+");
    try {
      const start = Math.max(0, st.size - CHUNK);
      const buf = Buffer.alloc(st.size - start);
      await fd.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      if (text.endsWith("\n")) return; // clean tail
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline < 0) {
        // The whole file is a single partial line.
        await fd.truncate(0);
        return;
      }
      const keep = start + lastNewline + 1;
      await fd.truncate(keep);
    } finally {
      await fd.close();
    }
  } catch {
    // File does not exist or is not readable — nothing to salvage.
  }
}

export async function ensureCategoryDir(baseDir: string, category: RecordCategory): Promise<string> {
  const dir = join(baseDir, category);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Date/hour keys for a timestamp (for logging/tests). */
export function rotationKeys(tsMs: number): { dateKey: string; hourKey: string } {
  return { dateKey: utcDateKey(tsMs), hourKey: utcHourKey(tsMs) };
}