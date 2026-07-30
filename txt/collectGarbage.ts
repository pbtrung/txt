// --collect-garbage: sweeps rqlite_txt.db's own page-store tables --
// page versions superseded before the GC watermark, and expired
// active_readers leases -- per docs/data_model.md's "rqlite Page Store".
// Only ever touches rqlite_txt.db; the R2/S3 bucket is untouched (that's
// what --clean-bucket is for). sweepGarbage() is the reusable sweep itself
// (also used by --vacuum, on its own already-open connection); this file's
// CollectGarbageCommand is just the standalone-command wrapper around it.

import { RqliteDb } from "./rqliteDb.ts";

export interface SweepOptions {
  dryRun: boolean;
  verbose: boolean;
}

export interface SweepResult {
  /** True if needs_gc wasn't set -- nothing has changed since the last sweep, so nothing else ran. */
  skipped: boolean;
  pagesRemoved: number;
  readersRemoved: number;
}

/** Sweeps one tenant's garbage on an already-open RqliteDb. Caller owns open/close. */
export function sweepGarbage(rqliteDb: RqliteDb, userId: string, opts: SweepOptions): SweepResult {
  if (!rqliteDb.needsGc(userId)) return { skipped: true, pagesRemoved: 0, readersRemoved: 0 };
  if (!opts.dryRun) rqliteDb.recordGcRun();
  const watermark = rqliteDb.gcWatermark(userId);
  logIf(opts, `gc watermark: version ${watermark}`);
  const readersRemoved = sweepReaders(rqliteDb, userId, opts);
  const pagesRemoved = sweepPages(rqliteDb, userId, watermark, opts);
  if (!opts.dryRun) {
    rqliteDb.clearNeedsGc(userId);
    rqliteDb.flush();
  }
  return { skipped: false, pagesRemoved, readersRemoved };
}

function sweepReaders(rqliteDb: RqliteDb, userId: string, opts: SweepOptions): number {
  let count = 0;
  for (const readerId of rqliteDb.expiredReaderIds(userId)) {
    if (opts.dryRun) {
      console.log(`would remove expired reader lease: ${readerId}`);
    } else {
      rqliteDb.deleteReader(userId, readerId);
      logIf(opts, `removed expired reader lease: ${readerId}`);
    }
    count++;
  }
  return count;
}

function sweepPages(
  rqliteDb: RqliteDb,
  userId: string,
  watermark: number,
  opts: SweepOptions,
): number {
  let count = 0;
  for (const { pageNo, version } of rqliteDb.garbagePages(userId, watermark)) {
    if (opts.dryRun) {
      console.log(`would delete: page ${pageNo} version ${version}`);
    } else {
      rqliteDb.deleteGarbagePage(userId, pageNo, version);
      logIf(opts, `deleted: page ${pageNo} version ${version}`);
    }
    count++;
  }
  return count;
}

function logIf(opts: SweepOptions, message: string): void {
  if (opts.verbose) console.log(message);
}

export interface CollectGarbageOptions extends SweepOptions {
  dbPath: string;
}

export class CollectGarbageCommand {
  private readonly opts: CollectGarbageOptions;

  constructor(opts: CollectGarbageOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const rqliteDb = await RqliteDb.openExisting(this.opts.dbPath, { readOnly: this.opts.dryRun });
    try {
      const userId = rqliteDb.findAdminUserId();
      if (!userId) {
        console.log("no admin account found; nothing to collect");
        return;
      }
      const result = sweepGarbage(rqliteDb, userId, this.opts);
      if (result.skipped) {
        console.log("needs_gc is not set; nothing has changed since the last sweep");
        return;
      }
      this.report(result);
    } finally {
      rqliteDb.close();
    }
  }

  private report(result: SweepResult): void {
    const verb = this.opts.dryRun ? "would remove" : "removed";
    console.log(
      `\n${verb} ${result.pagesRemoved} garbage page version(s), ${result.readersRemoved} expired reader lease(s)`,
    );
  }
}
