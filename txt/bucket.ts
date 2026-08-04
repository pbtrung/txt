// Orchestrator: port of txt/bucket.py's TxtBucketCleaner. Deletes every R2
// object not referenced by one account's txt_parts/txt_metadata.
import type { Creds } from "./creds.ts";
import type { Logger } from "./logger.ts";
import type { KnownPaths, TxtOwner } from "./owner.ts";
import type { DeleteResult, ObjectInfo, R2Client } from "./r2.ts";
import { formatBytes, type RunStats } from "./stats.ts";

export interface CleanBucketOptions {
  dryRun: boolean;
  // Returns true to proceed with deletion; called only in live mode with
  // at least one orphan, after listing/orphan computation (so the prompt
  // can state the real count/bytes).
  confirm: (message: string) => Promise<boolean>;
}

export interface CleanBucketResult {
  stats: RunStats;
  orphans: ObjectInfo[];
}

function computeOrphans(
  objects: ObjectInfo[],
  known: Set<string>,
): ObjectInfo[] {
  return objects.filter((o) => !known.has(o.key));
}

function totalBytes(objects: ObjectInfo[]): number {
  return objects.reduce((sum, o) => sum + o.size, 0);
}

export class TxtBucketCleaner {
  private owner: TxtOwner;
  private r2: R2Client;
  private log: Logger;

  constructor(owner: TxtOwner, r2: R2Client, log: Logger) {
    this.owner = owner;
    this.r2 = r2;
    this.log = log;
  }

  async clean(
    creds: Creds,
    opts: CleanBucketOptions,
  ): Promise<CleanBucketResult> {
    const startedAt = Date.now();
    const knownPaths = this.resolveKnownPaths(creds);
    const objects = await this.r2.listAllObjects();
    const orphans = computeOrphans(objects, knownPaths.known);
    this.log.info(
      `Found ${orphans.length} orphaned object(s) not present in DB (${formatBytes(totalBytes(orphans))})`,
    );
    const deleteResult = await this.maybeDelete(creds, orphans, opts);
    const stats = this.buildStats(
      opts.dryRun,
      knownPaths,
      objects,
      orphans,
      deleteResult,
      startedAt,
    );
    return { stats, orphans };
  }

  private resolveKnownPaths(creds: Creds): KnownPaths {
    const userId = this.owner.resolveUserId(creds);
    const umk = this.owner.resolveUmk(creds, userId);
    const result = this.owner.collectKnownRawPaths(userId, umk);
    this.log.info(
      `Found ${result.known.size} known path(s) in DB for user_id=${userId}`,
    );
    return result;
  }

  private async maybeDelete(
    creds: Creds,
    orphans: ObjectInfo[],
    opts: CleanBucketOptions,
  ): Promise<DeleteResult> {
    if (opts.dryRun || orphans.length === 0)
      return { deletedKeys: new Set(), errors: [] };
    await this.confirmOrAbort(creds, orphans, opts.confirm);
    const result = await this.r2.deleteObjects(orphans.map((o) => o.key));
    this.log.info(
      `Deleted ${result.deletedKeys.size} orphaned object(s) from the R2 bucket`,
    );
    return result;
  }

  private async confirmOrAbort(
    creds: Creds,
    orphans: ObjectInfo[],
    confirm: CleanBucketOptions["confirm"],
  ): Promise<void> {
    const message = `Delete ${orphans.length} orphaned object(s) (${formatBytes(totalBytes(orphans))}) from bucket=${creds.r2Config.bucket} for username=${creds.username}? This cannot be undone.`;
    if (!(await confirm(message))) throw new Error("Aborted.");
  }

  private buildStats(
    dryRun: boolean,
    knownPaths: KnownPaths,
    objects: ObjectInfo[],
    orphans: ObjectInfo[],
    deleteResult: DeleteResult,
    startedAt: number,
  ): RunStats {
    const deleted = orphans.filter((o) => deleteResult.deletedKeys.has(o.key));
    return {
      dryRun,
      txtCount: knownPaths.txtCount,
      totalKnownPaths: knownPaths.known.size,
      metadataObjectFound: knownPaths.metadataRawPath !== null,
      totalObjects: objects.length,
      orphanCount: orphans.length,
      orphanBytes: totalBytes(orphans),
      deletedCount: deleteResult.deletedKeys.size,
      deletedBytes: totalBytes(deleted),
      deleteErrors: deleteResult.errors,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
