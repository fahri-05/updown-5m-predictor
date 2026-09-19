import { describe, expect, it } from "vitest";
import { backoffSequence, exponentialBackoff } from "../src/utils/reconnect.js";

describe("exponential backoff", () => {
  it("grows 1s 2s 4s 8s then caps at 30s", () => {
    const seq = backoffSequence(
      { initialDelayMs: 1000, maxDelayMs: 30_000, jitterRatio: 0 },
      12,
    );
    expect(seq[0]).toBe(1000);
    expect(seq[1]).toBe(2000);
    expect(seq[2]).toBe(4000);
    expect(seq[3]).toBe(8000);
    expect(seq[4]).toBe(16_000);
    expect(seq[5]).toBe(30_000); // capped
    expect(seq[6]).toBe(30_000);
    expect(seq[11]).toBe(30_000);
  });

  it("respects a custom max and small initial delay", () => {
    const seq = backoffSequence(
      { initialDelayMs: 500, maxDelayMs: 5000, jitterRatio: 0 },
      8,
    );
    expect(seq[0]).toBe(500);
    expect(seq[1]).toBe(1000);
    expect(seq[2]).toBe(2000);
    expect(seq[3]).toBe(4000);
    expect(seq[4]).toBe(5000); // capped
  });

  it("never returns a negative delay", () => {
    for (let i = 0; i < 50; i += 1) {
      const d = exponentialBackoff(i, {
        initialDelayMs: 100,
        maxDelayMs: 1000,
        jitterRatio: 0.5,
      });
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("attempt resets after a successful connection (attempt 0 is initial)", () => {
    expect(exponentialBackoff(0, { initialDelayMs: 1000, maxDelayMs: 30_000 })).toBe(1000);
    expect(exponentialBackoff(0, { initialDelayMs: 1000, maxDelayMs: 30_000 })).toBe(1000);
  });
});