/**
 * npm run dataset:build — builds ML-ready dataset from collected raw snapshots.
 *
 * Walks data/snapshots/*.jsonl, computes multi-scale features with FeatureBuilder,
 * assigns binary resolution labels with ResolutionLabelBuilder, and exports
 * the resulting dataset to CSV and JSONL in data/dataset/.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { createLogger } from "../utils/logger.js";
import { DatasetBuilder } from "../dataset/dataset-builder.js";

async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonl(p)));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export async function datasetBuild(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel as never);

  const snapshotsDir = join(config.dataDir, "snapshots");
  const snapshotFiles = await walkJsonl(snapshotsDir);

  logger.info(`Found ${snapshotFiles.length} snapshot file(s) in ${snapshotsDir}`);
  if (snapshotFiles.length === 0) {
    logger.warn("No snapshot files found. Run the collector first with 'npm run dev'.");
    return;
  }

  const builder = new DatasetBuilder();
  logger.info("Building dataset (calculating features and window resolution labels)...");

  const result = await builder.buildFromFiles(snapshotFiles);

  logger.info(
    `Dataset built: ${result.records.length} samples across ${result.validWindows} window(s). ` +
      `Outcomes: UP=${result.upCount}, DOWN=${result.downCount}`,
  );

  for (const [slug, label] of result.windowLabels.entries()) {
    logger.info(
      ` Window ${slug}: [${label.label}] target=${label.target} ` +
        `P_start=${label.startPrice.toFixed(2)} P_end=${label.endPrice.toFixed(2)} ` +
        `diff=${label.priceDiff >= 0 ? "+" : ""}${label.priceDiff.toFixed(2)} (${label.priceChangePct.toFixed(3)}%) ` +
        `rule=${label.ruleId}`,
    );
  }

  if (result.records.length > 0) {
    const outputDir = join(config.dataDir, "dataset");
    const { csvPath, jsonlPath, count } = await builder.saveDataset(result.records, outputDir, "dataset");
    logger.info(`Dataset saved: ${count} rows`);
    logger.info(`  CSV:   ${csvPath}`);
    logger.info(`  JSONL: ${jsonlPath}`);
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  datasetBuild().catch((err) => {
    process.stderr.write(`fatal: ${String(err)}\n`);
    process.exitCode = 1;
  });
}