/**
 * Minimal structured logger.
 * Every line carries a UTC ISO-8601 timestamp (never local time).
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_NUMS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export interface Logger {
  debug(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
  /** Returns a logger that prefixes every line with a namespace string. */
  child(namespace: string): Logger;
}

export function createLogger(minLevel: LogLevel = "info"): Logger {
  const min = LEVEL_NUMS[minLevel] ?? LEVEL_NUMS.info;

  const emit = (level: Exclude<LogLevel, "silent">, ns: string, parts: unknown[]) => {
    if (LEVEL_NUMS[level] < min) return;
    const iso = new Date().toISOString();
    const body = parts
      .map((p) => (typeof p === "string" ? p : JSON.stringify(p) ?? String(p)))
      .join(" ");
    process.stdout.write(`[${iso}] [${level.toUpperCase()}]${ns} ${body}\n`);
  };

  const makeChild = (ns: string): Logger => ({
    debug: (...p) => emit("debug", ns, p),
    info: (...p) => emit("info", ns, p),
    warn: (...p) => emit("warn", ns, p),
    error: (...p) => emit("error", ns, p),
    child: (childNs) => makeChild(`${ns} ${childNs}`),
  });

  return makeChild("");
}

export const defaultLogger: Logger = createLogger(
  (process.env.LOG_LEVEL as LogLevel) ?? "info",
);