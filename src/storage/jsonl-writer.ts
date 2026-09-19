/**
 * Backpressure-aware buffered JSONL writer with automatic UTC-hour rotation.
 *
 *  - one JSON object per line, flushed in bounded batches
 *  - appends safely (stream opened in append mode; tail is salvaged on reopen)
 *  - never holds the full dataset in RAM (bounded queue, drops with a warn)
 *  - memory is released on rotation (new day/hour => new stream)
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Logger } from "../utils/logger.js";
import { defaultLogger } from "../utils/logger.js";
import { nowMs } from "../utils/time.js";
import { recordPath, salvageJsonlTail, type RecordCategory } from "./file-rotation.js";

const MAX_QUEUE = 20_000;
const BATCH_SIZE = 500;

export interface JsonlWriter {
  /** Serializes and appends a record. Resolves false when the queue is full. */
  append(record: unknown, tsMs?: number): Promise<boolean>;
  /** Waits until the write queue is drained (data handed to the OS). */
  flush(): Promise<void>;
  /** Flushes and closes the current stream. */
  close(): Promise<void>;
  readonly currentPath: string | null;
}

export class BufferedJsonlWriter implements JsonlWriter {
  private stream: WriteStream | null = null;
  private currentPathValue: string | null = null;
  private currentKey: string | null = null;
  private queue: Array<{ line: string; key: string }> = [];
  private drainPromise: Promise<void> = Promise.resolve();
  private closed = false;
  private droppedRecords = 0;
  private totalAppended = 0;

  constructor(
    private readonly baseDir: string,
    private readonly category: RecordCategory,
    private readonly logger: Logger = defaultLogger,
    private readonly maxQueue: number = MAX_QUEUE,
  ) {}

  get currentPath(): string | null {
    return this.currentPathValue;
  }

  append(record: unknown, tsMs: number = nowMs()): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    const path = recordPath(this.baseDir, this.category, tsMs);
    const key = `${path}`;
    const line = JSON.stringify(record);
    if (line === undefined) return Promise.resolve(false);

    if (this.queue.length >= this.maxQueue) {
      if (this.droppedRecords % 1000 === 0) {
        this.logger.warn(
          `${this.category} writer queue full — dropping records (total dropped: ${this.droppedRecords + 1})`,
        );
      }
      this.droppedRecords += 1;
      return Promise.resolve(false);
    }

    // Eagerly announce the target file so currentPath reflects the destination
    // of the most recent append even before the drain opens the stream.
    if (this.currentKey !== key) {
      this.currentKey = key;
      this.currentPathValue = key;
    }

    this.queue.push({ line, key });
    this.totalAppended += 1;
    if (this.queue.length >= BATCH_SIZE) this.scheduleDrain();
    return Promise.resolve(true);
  }

  async flush(): Promise<void> {
    this.scheduleDrain();
    await this.drainPromise;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.scheduleDrain();
    await this.drainPromise;
    await new Promise<void>((resolve) => {
      const s = this.stream;
      this.stream = null;
      this.currentPathValue = null;
      this.currentKey = null;
      if (s) {
        s.once("close", () => resolve());
        s.end();
        // Safety: never wait forever on a hung stream during shutdown.
        const t = setTimeout(() => resolve(), 2000);
        s.once("close", () => clearTimeout(t));
      } else {
        resolve();
      }
    });
  }

  /** Internal single-writer drain loop. */
  private scheduleDrain(): void {
    if (this.queue.length === 0) return;
    this.drainPromise = this.drainPromise.then(() => this.drainOnce());
  }

  private async drainOnce(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH_SIZE);
      let streamingFailed = false;
      for (const { line, key } of batch) {
        try {
          await this.ensureStream(key);
          if (!this.stream) {
            streamingFailed = true;
            break;
          }
          this.stream.write(line + "\n");
        } catch (err) {
          this.logger.error(`jsonl write failed: ${String(err)}`);
          streamingFailed = true;
          break;
        }
      }
      if (streamingFailed) {
        // Requeue the undrained remainder to keep order; drop the head batch.
        this.queue.unshift(...batch);
        this.queue.splice(0, Math.min(1000, batch.length));
      }
    }
  }

  private async ensureStream(key: string): Promise<void> {
    if (this.stream && this.currentKey === key && this.currentPathValue === key) return;
    // Rotate: close the old stream before opening the new file.
    if (this.stream) {
      await new Promise<void>((resolve) => {
        const s = this.stream!;
        s.once("close", () => resolve());
        s.end();
        const t = setTimeout(() => resolve(), 1000);
        s.once("close", () => clearTimeout(t));
      });
      this.stream = null;
      this.currentKey = null;
      this.currentPathValue = null;
    }
    await mkdir(dirname(key), { recursive: true });
    await salvageJsonlTail(key);
    const stream = createWriteStream(key, { flags: "a" });
    // Await actual open so the file exists as soon as drain completes (keeps
    // flush() semantics honest and avoids races in tests/shutdown).
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", (err: Error) => reject(err));
    });
    this.stream = stream;
    this.currentKey = key;
    this.currentPathValue = key;
    this.logger.debug(`rotated ${this.category} writer to ${key}`);
  }
}

export function createJsonlWriter(
  baseDir: string,
  category: RecordCategory,
  logger: Logger = defaultLogger,
): JsonlWriter {
  return new BufferedJsonlWriter(baseDir, category, logger);
}