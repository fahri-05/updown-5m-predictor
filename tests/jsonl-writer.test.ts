import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BufferedJsonlWriter } from "../src/storage/jsonl-writer.js";
import { recordPath } from "../src/storage/file-rotation.js";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("silent");

describe("JSONL writer", () => {
  it("writes one JSON object per line and appends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nn-pm-"));
    const w = new BufferedJsonlWriter(dir, "btc", logger);
    const t = Date.UTC(2026, 8, 10, 14, 0, 0, 0);
    await w.append({ timestampMs: t, v: 1 }, t);
    await w.append({ timestampMs: t + 1, v: 2 }, t + 1);
    await w.flush();
    await w.close();

    const content = await readFile(join(dir, "btc", "2026-09-10", "14.jsonl"), "utf8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(JSON.stringify({ timestampMs: t, v: 1 }));
    const parsed = lines.map((l) => JSON.parse(l)) as { v: number }[];
    expect(parsed.map((p) => p.v)).toEqual([1, 2]);

    await rm(dir, { recursive: true, force: true });
  });

  it("rotates files by UTC hour", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nn-pm-"));
    const w = new BufferedJsonlWriter(dir, "btc", logger);
    const t13 = Date.UTC(2026, 8, 10, 13, 59, 59, 900);
    const t14 = Date.UTC(2026, 8, 10, 14, 0, 0, 100);
    await w.append({ ts: t13 }, t13);
    await w.append({ ts: t14 }, t14);
    await w.flush();
    await w.close();

    const f13 = await readFile(join(dir, "btc", "2026-09-10", "13.jsonl"), "utf8");
    const f14 = await readFile(join(dir, "btc", "2026-09-10", "14.jsonl"), "utf8");
    expect(f13.trim().split("\n")).toHaveLength(1);
    expect(f14.trim().split("\n")).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });

  it("appends to an existing file instead of overwriting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nn-pm-"));
    const w1 = new BufferedJsonlWriter(dir, "btc", logger);
    const t = Date.UTC(2026, 8, 10, 14, 0, 0, 0);
    await w1.append({ seq: 1 }, t);
    await w1.flush();
    await w1.close();

    const w2 = new BufferedJsonlWriter(dir, "btc", logger);
    await w2.append({ seq: 2 }, t);
    await w2.flush();
    await w2.close();

    const content = await readFile(join(dir, "btc", "2026-09-10", "14.jsonl"), "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2]);

    await rm(dir, { recursive: true, force: true });
  });

  it("reports the current file path and flushes promptly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nn-pm-"));
    const w = new BufferedJsonlWriter(dir, "snapshots", logger);
    const t = Date.UTC(2026, 8, 10, 14, 0, 0, 0);
    await w.append({ a: 1 }, t);
    expect(w.currentPath).toBe(recordPath(dir, "snapshots", t));
    await w.flush();
    const files = await readdir(join(dir, "snapshots", "2026-09-10"), { recursive: true });
    expect(files).toContain("14.jsonl");
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("bounded queue: drops with a warning rather than growing memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nn-pm-"));
    const w = new BufferedJsonlWriter(dir, "btc", logger, 10);
    const t = Date.UTC(2026, 8, 10, 14, 0, 0, 0);
    const accepted = [];
    for (let i = 0; i < 1000; i += 1) accepted.push(await w.append({ i }, t));
    expect(accepted.filter(Boolean).length).toBeLessThan(200);
    await w.flush();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
});