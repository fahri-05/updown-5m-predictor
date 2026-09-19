/**
 * Exponential-backoff scheduling for WebSocket reconnection.
 * Pure functions here are unit-tested; the stateful scheduler lives in
 * reconnecting-socket.ts.
 */

export interface ReconnectOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  /** Multiplication factor between attempts (default 2). */
  backoffFactor?: number;
  /** Fraction of the delay used as random jitter (default 0) — e.g. 0.2. */
  jitterRatio?: number;
}

/**
 * Pure exponential backoff computation.
 * attempt 0 -> initialDelayMs, then initial*2^attempt, capped at maxDelayMs.
 * The cap floor is the initial delay so flat "30s, 30s, 30s…" days follow.
 */
export function exponentialBackoff(
  attempt: number,
  opts: ReconnectOptions,
): number {
  const safeAttempt = Math.max(0, attempt);
  const factor = opts.backoffFactor && opts.backoffFactor > 0 ? opts.backoffFactor : 2;
  const raw = opts.initialDelayMs * Math.pow(factor, safeAttempt);
  const clampedRaw = Math.min(Math.max(raw, opts.initialDelayMs), opts.maxDelayMs);
  const jitterRatio = opts.jitterRatio ?? 0;
  const jitter =
    jitterRatio > 0 ? clampedRaw * (Math.random() * jitterRatio - jitterRatio / 2) : 0;
  return Math.max(0, Math.round(clampedRaw + jitter));
}

/** Generates the expected backoff sequence (e.g. 1000, 2000, 4000, 8000, 30000…). */
export function backoffSequence(opts: ReconnectOptions, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(exponentialBackoff(i, { ...opts, jitterRatio: 0 }));
  return out;
}