/**
 * Reconnecting WebSocket wrapper shared by all feeds.
 *
 * Responsibilities:
 *  - exponential backoff reconnection (1s, 2s, 4s, … capped at max delay)
 *  - staleness detection (no message within staleTimeoutMs -> reconnect)
 *  - optional application-level heartbeat (text frames, e.g. Polymarket PING)
 *  - per-feature resubscribe hook after every (re)connect
 *  - connection lifecycle & health tracking
 */

import WebSocket, { type RawData } from "ws";

import type { ConnectionStatus, ExchangeHealth } from "../types/market.js";
import type { Logger } from "./logger.js";
import { exponentialBackoff } from "./reconnect.js";
import { nowMs } from "./time.js";

export interface ReconnectingSocketOptions {
  url: string;
  logger: Logger;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  staleTimeoutMs: number;
  healthCheckIntervalMs: number;
  /** Called after every successful (re)connect — resubscribe here. */
  onOpen?: () => void;
  onMessage?: (data: string, receivedTimestampMs: number) => void;
  onClose?: (code: number, reason: string) => void;
  onStale?: () => void;
  /** Returns the text frame to send as an application heartbeat (e.g. "PING"). */
  pingMessage?: () => string | null;
  /** How often the heartbeat is sent (ms, default 5000). */
  pingIntervalMs?: number;
  /** Optional on-error diagnostics hook (non-fatal). */
  onError?: (err: Error) => void;
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private attempt = 0;
  private reconnectCount = 0;
  private lastMessageTimestampMs: number | null = null;
  private lastSuccessfulConnectionMs: number | null = null;
  private status: ConnectionStatus = "idle";
  private openWaiters: Array<() => void> = [];

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  /** Returns current connection health (status + timestamps + reconnect count). */
  health(): ExchangeHealth {
    return {
      status: this.status,
      lastMessageTimestampMs: this.lastMessageTimestampMs,
      lastSuccessfulConnectionMs: this.lastSuccessfulConnectionMs,
      reconnectCount: this.reconnectCount,
    };
  }

  get isOpen(): boolean {
    return this.status === "open";
  }

  /** Sends a text frame when connected; returns false when not open. */
  sendText(frame: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(frame);
      return true;
    } catch (err) {
      this.opts.logger.debug(`send failed: ${String(err)}`);
      return false;
    }
  }

  /** Blocks until the socket is open (initial connection or after a reconnect). */
  async whenOpen(): Promise<void> {
    if (this.status === "open") return;
    if (this.stopRequested) throw new Error("reconnecting socket is stopped");
    await new Promise<void>((resolve) => {
      this.openWaiters.push(resolve);
    });
  }

  /** Starts the (re)connecting loop. Resolves once a connection opens. */
  async connect(): Promise<void> {
    // connect() is the entry point for (re)start, so it clears the stop flag.
    this.stopRequested = false;
    if (this.status === "connecting" || this.status === "open") {
      this.opts.logger.debug("connect() called while already connected");
      return this.whenOpen();
    }
    this.attempt = 0;
    this.openSocket();
    await this.whenOpen();
  }

  /** Gracefully closes the socket and stops all timers. */
  async disconnect(): Promise<void> {
    this.stopRequested = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      const closed = new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.once("error", () => resolve());
      });
      try {
        ws.close(1000, "collector shutdown");
      } catch {
        /* already closing */
      }
      const safety = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
      }, 1500);
      closed.then(() => clearTimeout(safety));
      await closed;
    }
    this.status = "closed";
  }

  /** Force-closes the current socket without scheduling a reconnect. */
  private forceClose(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.terminate();
      } catch {
        /* noop */
      }
    }
    this.status = "closed";
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private openSocket(): void {
    if (this.stopRequested) return;
    this.status = "connecting";
    this.opts.logger.debug(`connecting to ${this.opts.url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this.opts.logger.error(`failed to construct WebSocket: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => this.handleOpen());
    ws.on("message", (data: RawData) => this.handleMessage(data));
    ws.on("error", (err) => {
      this.opts.logger.debug(`socket error: ${err.message}`);
      this.opts.onError?.(err as Error);
    });
    ws.on("close", (code: number, reason: Buffer) =>
      this.handleClose(code, reason.toString()),
    );
  }

  private handleOpen(): void {
    this.lastSuccessfulConnectionMs = nowMs();
    this.status = "open";
    this.attempt = 0;
    this.reconnectTimer = null;
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const resolve of waiters) resolve();

    this.startTimers();
    this.opts.logger.info(`connected to ${this.opts.url}`);
    // Resubscribe after every connect (prevents duplicate subs: only runs on open).
    this.opts.onOpen?.();
  }
private handleMessage(data: RawData): void {
    this.lastMessageTimestampMs = nowMs();
    const text = data.toString();
    this.opts.onMessage?.(text, this.lastMessageTimestampMs);
  }

  private handleClose(code: number, reason: string): void {
    this.opts.logger.debug(`socket closed code=${code} reason=${reason}`);
    this.ws = null;
    this.clearTimers();
    this.status = "closed";
    this.opts.onClose?.(code, reason);
    if (!this.stopRequested) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) return;
    if (this.reconnectTimer) return; // already scheduled — prevents duplicate timers
    this.attempt += 1;
    this.reconnectCount += 1;
    const delay = exponentialBackoff(
      this.attempt - 1,
      {
        initialDelayMs: this.opts.reconnectInitialDelayMs,
        maxDelayMs: this.opts.reconnectMaxDelayMs,
      },
    );
    this.status = "reconnecting";
    this.opts.logger.info(
      `reconnecting to ${this.opts.url} in ${delay}ms (attempt ${this.attempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private startTimers(): void {
    this.clearTimers();
    const ping = this.opts.pingMessage;
    if (ping) {
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const frame = ping();
          if (frame) {
            try {
              this.ws.send(frame);
            } catch (err) {
              this.opts.logger.debug(`ping send failed: ${String(err)}`);
            }
          }
        }
      }, this.opts.pingIntervalMs ?? 5000);
    }
    this.healthTimer = setInterval(() => {
      if (this.stopRequested) return;
      if (this.status !== "open") return;
      const last = this.lastMessageTimestampMs;
      if (last !== null && nowMs() - last > this.opts.staleTimeoutMs) {
        this.opts.logger.warn(
          `stale connection detected (no message for ${nowMs() - last}ms)`,
        );
        this.opts.onStale?.();
        this.forceClose();
        this.scheduleReconnect();
      }
    }, this.opts.healthCheckIntervalMs);
  }
}