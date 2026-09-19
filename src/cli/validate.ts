/**
 * npm run validate — offline JSONL integrity check.
 *
 * Walks data/{btc,polymarket,snapshots,errors}/*.jsonl and verifies:
 *  - every line parses as JSON
 *  - timestampMs / timestampUtc are present and consistent
 * Exits non-zero when invalid records are found.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { createLogger } from "../utils/logger.js";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export async function validateDataset(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel as never);

  let files = 0;
  let lines = 0;
  let errors = 0;

  for (const category of ["btc", "polymarket", "snapshots", "errors"]) {
    const dir = join(config.dataDir, category);
    for (const file of await walk(dir)) {
      files += 1;
      const content = await readFile(file, "utf8");
      for (const [i, line] of content.split("\n").entries()) {
        if (line.trim() === "") continue;
        lines += 1;
        try {
          const obj = JSON.parse(line) as { timestampMs?: unknown; timestampUtc?: unknown };
          if (typeof obj.timestampMs !== "number" || typeof obj.timestampUtc !== "string") {
            logger.warn(`invalid record ${file}:${i + 1} — missing timestamp fields`);
            errors += 1;
          } else if (Date.parse(obj.timestampUtc) !== obj.timestampMs) {
            logger.warn(`timestamp mismatch ${file}:${i + 1}: ${obj.timestampUtc} != ${obj.timestampMs}`);
            errors += 1;
          }
        } catch {
          logger.warn(`unparseable JSON ${file}:${i + 1}`);
          errors += 1;
        }
      }
    }
  }

  logger.info(`validation complete — ${files} file(s), ${lines} record(s), ${errors} error(s)`);
  if (errors > 0) {
    logger.error("dataset validation FAILED");
    process.exitCode = 1;
  } else {
    logger.info("dataset validation OK");
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  validateDataset().catch((err) => {
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exitCode = 1;
  });
}