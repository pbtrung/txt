// --collect-garbage: sweeps rqlite_txt.db's own page-store tables --
// page versions superseded before the GC watermark, and expired
// active_readers leases -- per docs/data_model.md's "rqlite Page Store".
// Only ever touches rqlite_txt.db; the R2/S3 bucket is untouched (that's
// what --clean-bucket is for).

import { RqliteDb } from "./rqliteDb.ts";

export interface CollectGarbageOptions {
  dbPath: string;
  dryRun: boolean;
  verbose: boolean;
}

export class CollectGarbageCommand {
  private readonly opts: CollectGarbageOptions;
  private pagesRemoved = 0;
  private readersRemoved = 0;

  constructor(opts: CollectGarbageOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const rqliteDb = await RqliteDb.openExisting(this.opts.dbPath, { readOnly: this.opts.dryRun });
    try {
      await this.sweep(rqliteDb);
    } finally {
      rqliteDb.close();
    }
  }

  private async sweep(rqliteDb: RqliteDb): Promise<void> {
    const userId = rqliteDb.findAdminUserId();
    if (!userId) {
      console.log("no admin account found; nothing to collect");
      return;
    }
    if (!rqliteDb.needsGc(userId)) {
      console.log("needs_gc is not set; nothing has changed since the last sweep");
      return;
    }
    if (!this.opts.dryRun) rqliteDb.recordGcRun();
    const watermark = rqliteDb.gcWatermark(userId);
    this.log(`gc watermark: version ${watermark}`);
    this.collectExpiredReaders(rqliteDb, userId);
    this.collectPages(rqliteDb, userId, watermark);
    if (!this.opts.dryRun) {
      rqliteDb.clearNeedsGc(userId);
      rqliteDb.flush();
    }
    this.report();
  }

  private collectExpiredReaders(rqliteDb: RqliteDb, userId: string): void {
    for (const readerId of rqliteDb.expiredReaderIds(userId)) {
      if (this.opts.dryRun) {
        console.log(`would remove expired reader lease: ${readerId}`);
      } else {
        rqliteDb.deleteReader(userId, readerId);
        this.log(`removed expired reader lease: ${readerId}`);
      }
      this.readersRemoved++;
    }
  }

  private collectPages(rqliteDb: RqliteDb, userId: string, watermark: number): void {
    for (const { pageNo, version } of rqliteDb.garbagePages(userId, watermark)) {
      if (this.opts.dryRun) {
        console.log(`would delete: page ${pageNo} version ${version}`);
      } else {
        rqliteDb.deleteGarbagePage(userId, pageNo, version);
        this.log(`deleted: page ${pageNo} version ${version}`);
      }
      this.pagesRemoved++;
    }
  }

  private log(message: string): void {
    if (this.opts.verbose) console.log(message);
  }

  private report(): void {
    const verb = this.opts.dryRun ? "would remove" : "removed";
    console.log(
      `\n${verb} ${this.pagesRemoved} garbage page version(s), ${this.readersRemoved} expired reader lease(s)`,
    );
  }
}
