/**
 * UTC helpers used everywhere timestamps are produced or consumed.
 * Local system time is NEVER used for stored/dataset timestamps.
 */

/** Current Unix milliseconds (UTC). */
export function nowMs(): number {
  return Date.now();
}

/** Current UTC time as an ISO-8601 string with millisecond precision. */
export function isoUtc(tsMs?: number): string {
  return new Date(tsMs ?? Date.now()).toISOString();
}

/** Parse an ISO-8601 UTC string to Unix milliseconds. Throws on invalid input. */
export function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO timestamp: ${iso}`);
  return ms;
}

/** UTC hour bucket key "YYYY-MM-DD/HH" for a Unix-ms timestamp. */
export function utcHourKey(tsMs: number): string {
  const d = new Date(tsMs);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}/${hh}`;
}

/** UTC date key "YYYY-MM-DD" for a Unix-ms timestamp. */
export function utcDateKey(tsMs: number): string {
  const d = new Date(tsMs);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Bucket (ms boundary) of a UTC recurrence window of windowMs length. */
export function windowBucketMs(tsMs: number, windowMs: number): number {
  return Math.floor(tsMs / windowMs) * windowMs;
}