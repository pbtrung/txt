// Shared by txt.ts --migrate and --collect-garbage: for a set of documents,
// each with its own R2 prefix (docs/data_model.md's txt entity) and its own
// set of known raw_keys (every txtParts row's own decrypted raw_key,
// docs/protocols.md's Read path), lists each document's own prefix and
// deletes whatever isn't accounted for. The only way a legitimately-created
// object ends up here is a previous run that crashed between a part's own
// R2 PUT and its txtParts transact (docs/protocols.md's Ingest/write path
// failure mode).
import * as C from "./constants.ts";
import type { Logger } from "./logger.ts";
import type { R2Client } from "./r2.ts";

export interface OrphanSweepTarget {
  label: string; // for logging -- e.g. "txt_id=5" or a target `txt` row's own id
  prefix: string; // decrypted, not the wrapped blob
  knownRawKeys: Set<string>; // bare raw_key strings, not full R2 object keys
}

// One list call per document (each has its own prefix) rather than one for
// a whole account -- R2_BATCH_CONCURRENCY at a time rather than fully
// serial, since a large corpus could otherwise mean a long wait before any
// other work even starts. dryRun still lists/diffs (so callers can report
// an accurate count) but skips the actual delete -- --migrate always sweeps
// live (a stale object here is unambiguous crash cleanup, not something its
// own --dry-run is meant to preview), while --collect-garbage's whole job
// is this sweep, so its --dry-run has to actually mean something.
export async function sweepOrphanObjects(
  r2: R2Client,
  targets: OrphanSweepTarget[],
  log: Logger,
  dryRun: boolean,
): Promise<number> {
  let totalDeleted = 0;
  for (let i = 0; i < targets.length; i += C.R2_BATCH_CONCURRENCY) {
    const batch = targets.slice(i, i + C.R2_BATCH_CONCURRENCY);
    const deleted = await Promise.all(
      batch.map((target) => sweepOneDocument(r2, target, log, dryRun)),
    );
    totalDeleted += deleted.reduce((sum, n) => sum + n, 0);
  }
  return totalDeleted;
}

async function sweepOneDocument(
  r2: R2Client,
  target: OrphanSweepTarget,
  log: Logger,
  dryRun: boolean,
): Promise<number> {
  const objects = await r2.listAllObjects(`${target.prefix}/`);
  const stale = objects.filter((o) => {
    const rawKey = o.key.slice(target.prefix.length + 1);
    return !target.knownRawKeys.has(rawKey);
  });
  if (stale.length === 0) return 0;
  log.warn(
    `${target.label}: found ${stale.length} stale R2 object(s) under prefix=${target.prefix}/ ` +
      `(left by a previous incomplete run)${dryRun ? "" : " -- deleting"}`,
  );
  if (dryRun) return stale.length;
  const result = await r2.deleteObjects(stale.map((o) => o.key));
  for (const err of result.errors) {
    log.warn(`Failed to delete stale object ${err.key}: ${err.message}`);
  }
  return result.deletedKeys.size;
}
