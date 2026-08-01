import * as C from "./constants.ts";
import type { Logger } from "./logger.ts";
import type { ObjectInfo } from "./r2.ts";

export interface RunStats {
  dryRun: boolean;
  txtCount: number;
  totalKnownPaths: number;
  // Whether txt_metadata.content pointed at an R2 object that got added to
  // the keep-set (see txt/owner.ts's collectKnownRawPaths) -- false means
  // there's nothing to keep for it (no row, NULL content, or still the
  // legacy inline-JSON format), not that anything was missed.
  metadataObjectFound: boolean;
  totalObjects: number;
  orphanCount: number;
  orphanBytes: number;
  deletedCount: number;
  deletedBytes: number;
  deleteErrors: { key: string; message: string }[];
  elapsedMs: number;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

export class Reporter {
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  printOrphanPreview(orphans: ObjectInfo[]): void {
    const preview = orphans.slice(0, C.ORPHAN_PREVIEW_LIMIT);
    for (const o of preview)
      this.log.info(`  ${o.key}  (${formatBytes(o.size)})`);
    if (orphans.length > C.ORPHAN_PREVIEW_LIMIT) {
      this.log.info(`  ...and ${orphans.length - C.ORPHAN_PREVIEW_LIMIT} more`);
    }
  }

  printStats(stats: RunStats): void {
    this.log.info("--- clean-bucket summary ---");
    for (const line of this.statLines(stats)) this.log.info(line);
    if (stats.deleteErrors.length > 0) {
      this.log.error(
        `delete errors:      ${stats.deleteErrors.length} (see above)`,
      );
    }
  }

  private statLines(stats: RunStats): string[] {
    const mode = stats.dryRun ? "DRY RUN (no objects deleted)" : "LIVE";
    return [
      `mode:               ${mode}`,
      `txt documents:      ${stats.txtCount}`,
      `known paths (kept): ${stats.totalKnownPaths}`,
      `txt_metadata object: ${stats.metadataObjectFound ? "found, kept" : "not present"}`,
      `objects in bucket:  ${stats.totalObjects}`,
      `orphaned objects:   ${stats.orphanCount} (${formatBytes(stats.orphanBytes)})`,
      `deleted objects:    ${stats.deletedCount} (${formatBytes(stats.deletedBytes)})`,
      `elapsed:            ${(stats.elapsedMs / 1000).toFixed(2)}s`,
    ];
  }
}
