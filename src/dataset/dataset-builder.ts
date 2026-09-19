/**
 * DatasetBuilder — orchestrates FeatureBuilder and LabelBuilder to convert
 * raw JSONL snapshots into structured, labeled datasets ready for ML training.
 *
 * Each output row contains:
 *  - High-frequency engineered features at snapshot time T (no lookahead)
 *  - Supervised binary target (1 = UP, 0 = DOWN) based on Polymarket window resolution
 *  - Exporters to CSV and JSONL (directly consumable by Python / PyTorch / Pandas)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MarketSnapshot } from "../types/market.js";
import { FeatureBuilder, type SnapshotFeatures } from "./feature-builder.js";
import { ResolutionLabelBuilder, type WindowLabel } from "./label-builder.js";

export interface LabeledRecord extends SnapshotFeatures {
  target: 1 | 0;
  label: "UP" | "DOWN";
  windowLabelRule: string;
  windowStartPrice: number;
  windowEndPrice: number;
}

export interface DatasetBuildResult {
  records: LabeledRecord[];
  windowLabels: Map<string, WindowLabel>;
  totalSnapshots: number;
  validWindows: number;
  upCount: number;
  downCount: number;
}

export class DatasetBuilder {
  private featureBuilder: FeatureBuilder;
  private labelBuilder: ResolutionLabelBuilder;

  constructor(featureBuilder?: FeatureBuilder, labelBuilder?: ResolutionLabelBuilder) {
    this.featureBuilder = featureBuilder ?? new FeatureBuilder();
    this.labelBuilder = labelBuilder ?? new ResolutionLabelBuilder();
  }

  /**
   * Builds labeled ML records from an array of snapshots.
   */
  buildDataset(snapshots: MarketSnapshot[]): DatasetBuildResult {
    if (snapshots.length === 0) {
      return {
        records: [],
        windowLabels: new Map(),
        totalSnapshots: 0,
        validWindows: 0,
        upCount: 0,
        downCount: 0,
      };
    }

    // Sort snapshots chronologically
    const sorted = [...snapshots].sort((a, b) => a.timestampMs - b.timestampMs);

    // Group snapshots by market slug
    const grouped = new Map<string, MarketSnapshot[]>();
    for (const snap of sorted) {
      const slug = snap.market.slug || `window-${snap.market.startTimeMs ?? 0}`;
      if (!grouped.has(slug)) grouped.set(slug, []);
      grouped.get(slug)!.push(snap);
    }

    const allRecords: LabeledRecord[] = [];
    const windowLabels = new Map<string, WindowLabel>();
    let upCount = 0;
    let downCount = 0;

    for (const [slug, group] of grouped.entries()) {
      if (group.length < 2) continue;

      const first = group[0]!;
      const last = group[group.length - 1]!;
      const windowStartMs = first.market.startTimeMs ?? first.timestampMs;
      const windowEndMs = last.market.endTimeMs ?? last.timestampMs;

      let label: WindowLabel;
      try {
        label = this.labelBuilder.buildLabel({
          slug,
          windowStartMs,
          windowEndMs,
          snapshots: group,
        });
      } catch {
        // If window has insufficient data to resolve, skip labeling to prevent corrupted targets
        continue;
      }

      windowLabels.set(slug, label);
      if (label.target === 1) upCount += 1;
      else downCount += 1;

      // Extract features for all snapshots in this window
      const features = this.featureBuilder.buildFeatures(group);

      for (const feat of features) {
        allRecords.push({
          ...feat,
          target: label.target,
          label: label.label,
          windowLabelRule: label.ruleId,
          windowStartPrice: label.startPrice,
          windowEndPrice: label.endPrice,
        });
      }
    }

    return {
      records: allRecords,
      windowLabels,
      totalSnapshots: snapshots.length,
      validWindows: windowLabels.size,
      upCount,
      downCount,
    };
  }

  /**
   * Reads snapshots from JSONL files and constructs the dataset.
   */
  async buildFromFiles(filePaths: string[]): Promise<DatasetBuildResult> {
    const snapshots: MarketSnapshot[] = [];

    for (const file of filePaths) {
      const content = await readFile(file, "utf8").catch(() => "");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as MarketSnapshot;
          if (obj.timestampMs && obj.btc && obj.polymarket) {
            snapshots.push(obj);
          }
        } catch {
          // ignore corrupted lines
        }
      }
    }

    return this.buildDataset(snapshots);
  }

  /**
   * Serializes labeled records to CSV format.
   */
  toCsv(records: LabeledRecord[]): string {
    if (records.length === 0) return "";
    const headers = Object.keys(records[0]!);
    const lines = [headers.join(",")];

    for (const r of records) {
      const values = headers.map((h) => {
        const v = (r as unknown as Record<string, unknown>)[h];
        if (typeof v === "string") {
          return v.includes(",") ? `"${v}"` : v;
        }
        return v !== undefined && v !== null ? String(v) : "";
      });
      lines.push(values.join(","));
    }

    return lines.join("\n");
  }

  /**
   * Serializes labeled records to JSONL format.
   */
  toJsonl(records: LabeledRecord[]): string {
    return records.map((r) => JSON.stringify(r)).join("\n");
  }

  /**
   * Saves dataset to disk in both CSV and JSONL formats.
   */
  async saveDataset(
    records: LabeledRecord[],
    outputDir: string,
    prefix: string = "dataset",
  ): Promise<{ csvPath: string; jsonlPath: string; count: number }> {
    await mkdir(outputDir, { recursive: true });

    const csvPath = join(outputDir, `${prefix}.csv`);
    const jsonlPath = join(outputDir, `${prefix}.jsonl`);

    await writeFile(csvPath, this.toCsv(records), "utf8");
    await writeFile(jsonlPath, this.toJsonl(records), "utf8");

    return { csvPath, jsonlPath, count: records.length };
  }
}