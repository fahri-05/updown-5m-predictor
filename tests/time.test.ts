import { describe, expect, it } from "vitest";
import {
  isoToMs,
  isoUtc,
  nowMs,
  utcDateKey,
  utcHourKey,
  windowBucketMs,
} from "../src/utils/time.js";

describe("time utils (UTC)", () => {
  it("isoUtc produces ISO-8601 with Z (UTC) and milliseconds", () => {
    const s = isoUtc(1_700_000_000_123);
    expect(s).toBe("2023-11-14T22:13:20.123Z");
  });

  it("isoToMs round-trips exactly", () => {
    const ms = 1_700_000_000_123;
    expect(isoToMs(isoUtc(ms))).toBe(ms);
  });

  it("isoToMs rejects invalid input", () => {
    expect(() => isoToMs("not-a-date")).toThrow();
    expect(() => isoToMs("")).toThrow();
  });

  it("nowMs is close to Date.now() and is UTC-based", () => {
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(100);
  });

  it("utcHourKey returns date/hour buckets", () => {
    // 2026-09-10 14:23:51 UTC
    const ms = Date.UTC(2026, 0 + 8, 10, 14, 23, 51, 123);
    expect(utcHourKey(ms)).toBe("2026-09-10/14");
    expect(utcDateKey(ms)).toBe("2026-09-10");
  });

  it("utcHourKey does not depend on the local timezone", () => {
    // Midnight UTC on a known date.
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    expect(utcHourKey(ms)).toBe("2026-01-01/00");
  });

  it("windowBucketMs floors to 5-minute UTC boundaries", () => {
    const boundary = Date.UTC(2026, 8, 10, 14, 0, 0, 0); // 14:00:00.000
    expect(windowBucketMs(boundary + 1, 300_000)).toBe(boundary);
    expect(windowBucketMs(boundary + 299_999, 300_000)).toBe(boundary);
    expect(windowBucketMs(boundary + 300_000, 300_000)).toBe(boundary + 300_000);
    expect(windowBucketMs(boundary - 1, 300_000)).toBe(boundary - 300_000);
  });
});