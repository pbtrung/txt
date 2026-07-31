// Remote counterpart to rqliteDb.ts's garbage-collection methods -- used by
// --remote-vacuum to sweep a live deployment's own page-store tables
// (db_meta/pages/active_readers/gc_runs) over HTTP via the admin-only
// RAW_QUERY escape hatch, instead of requiring direct file access to
// rqlite_txt.db the way --collect-garbage/--vacuum do. Mirrors RqliteDb's
// method shapes closely (same SQL, same semantics) but every call is a real
// network round trip, hence async throughout -- not sharing an interface
// with RqliteDb's synchronous local methods, which nothing here needs to
// change to accommodate.

import { RqliteHttpClient, resultRows } from "./rqliteHttpClient.ts";

export interface GarbagePage {
  pageNo: number;
  version: number;
}

export interface SweepOptions {
  dryRun: boolean;
  verbose: boolean;
}

export interface SweepResult {
  skipped: boolean;
  pagesRemoved: number;
  readersRemoved: number;
}

export class RemoteRqliteDb {
  private readonly client: RqliteHttpClient;
  private readonly targetDbId: string;

  constructor(client: RqliteHttpClient, targetDbId: string) {
    this.client = client;
    this.targetDbId = targetDbId;
  }

  private async rawQuery(sql: string, args: unknown[] = []): Promise<unknown[][]> {
    const batch = args.length > 0 ? [{ sql, args }] : [{ sql }];
    return resultRows(await this.client.query("RAW_QUERY", batch));
  }

  private async rawExecute(sql: string, args: unknown[] = []): Promise<void> {
    const batch = args.length > 0 ? [{ sql, args }] : [{ sql }];
    resultRows(await this.client.execute("RAW_QUERY", batch));
  }

  /** True if a writer has committed since the last GC sweep cleared this flag. */
  async needsGc(): Promise<boolean> {
    const rows = await this.rawQuery("SELECT needs_gc FROM db_meta WHERE db_id=?", [
      this.targetDbId,
    ]);
    return !!rows[0] && Number(rows[0][0]) !== 0;
  }

  /** 0 if this tenant has never committed a page yet. */
  async currentVersion(): Promise<number> {
    const rows = await this.rawQuery("SELECT current_version FROM db_meta WHERE db_id=?", [
      this.targetDbId,
    ]);
    return rows[0] ? Number(rows[0][0]) : 0;
  }

  private async pageCount(): Promise<number> {
    const rows = await this.rawQuery("SELECT page_count FROM db_meta WHERE db_id=?", [
      this.targetDbId,
    ]);
    if (!rows[0]) throw new Error(`no db_meta row for ${this.targetDbId}`);
    return Number(rows[0][0]);
  }

  /** Oldest snapshot version any non-expired reader still needs, or current_version if none. */
  async gcWatermark(): Promise<number> {
    const rows = await this.rawQuery(
      "SELECT MIN(snapshot_version) FROM active_readers WHERE db_id=? AND lease_expires_at > ?",
      [this.targetDbId, Date.now()],
    );
    const watermark = rows[0]?.[0];
    return watermark != null ? Number(watermark) : this.currentVersion();
  }

  async expiredReaderIds(): Promise<string[]> {
    const rows = await this.rawQuery(
      "SELECT reader_id FROM active_readers WHERE db_id=? AND lease_expires_at<?",
      [this.targetDbId, Date.now()],
    );
    return rows.map((row) => String(row[0]));
  }

  async deleteReader(readerId: string): Promise<void> {
    await this.rawExecute("DELETE FROM active_readers WHERE db_id=? AND reader_id=?", [
      this.targetDbId,
      readerId,
    ]);
  }

  /** Page (page_no, version) pairs safe to delete -- see rqliteDb.ts's own
   * doc comment on garbagePages for the two classes this covers. */
  async garbagePages(watermark: number): Promise<GarbagePage[]> {
    const superseded = await this.supersededPages(watermark);
    if (watermark < (await this.currentVersion())) return superseded;
    return superseded.concat(await this.trailingPages(watermark));
  }

  private async supersededPages(watermark: number): Promise<GarbagePage[]> {
    const rows = await this.rawQuery(
      `SELECT page_no, version FROM pages AS p
       WHERE db_id = ?
         AND version < (
           SELECT MAX(version) FROM pages AS p2
           WHERE p2.db_id = p.db_id AND p2.page_no = p.page_no AND p2.version <= ?
         )`,
      [this.targetDbId, watermark],
    );
    return toGarbagePages(rows);
  }

  private async trailingPages(watermark: number): Promise<GarbagePage[]> {
    const pageCount = await this.pageCount();
    const rows = await this.rawQuery(
      "SELECT page_no, version FROM pages WHERE db_id=? AND page_no>? AND version<=?",
      [this.targetDbId, pageCount, watermark],
    );
    return toGarbagePages(rows);
  }

  async deleteGarbagePage(pageNo: number, version: number): Promise<void> {
    await this.rawExecute("DELETE FROM pages WHERE db_id=? AND page_no=? AND version=?", [
      this.targetDbId,
      pageNo,
      version,
    ]);
  }

  /** INSERT OR IGNORE into gc_runs for today -- bookkeeping only, doesn't gate this run. */
  async recordGcRun(): Promise<void> {
    const dayId = Math.floor(Date.now() / 86400000);
    await this.rawExecute("INSERT OR IGNORE INTO gc_runs (day_id, started_at) VALUES (?, ?)", [
      dayId,
      Date.now(),
    ]);
  }

  async clearNeedsGc(): Promise<void> {
    await this.rawExecute("UPDATE db_meta SET needs_gc=0 WHERE db_id=?", [this.targetDbId]);
  }

  /** Per rqlite's own performance guide (a plain SQL VACUUM over the
   * ordinary /db/execute API, no dedicated endpoint): may temporarily
   * double disk usage and blocks writes while it runs. */
  async vacuum(): Promise<void> {
    resultRows(await this.client.execute("RAW_QUERY", [{ sql: "VACUUM" }]));
  }
}

function toGarbagePages(rows: unknown[][]): GarbagePage[] {
  return rows.map((row) => ({ pageNo: Number(row[0]), version: Number(row[1]) }));
}

/** Mirrors commands.ts's sweepGarbage/sweepReaders/sweepPages (the local,
 * synchronous equivalent against rqliteDb.ts) -- same logic, async because
 * every step here is a real network round trip. */
export async function sweepGarbageRemote(
  remoteDb: RemoteRqliteDb,
  opts: SweepOptions,
): Promise<SweepResult> {
  if (!(await remoteDb.needsGc())) return { skipped: true, pagesRemoved: 0, readersRemoved: 0 };
  if (!opts.dryRun) await remoteDb.recordGcRun();
  const watermark = await remoteDb.gcWatermark();
  if (opts.verbose) console.log(`gc watermark: version ${watermark}`);
  const readersRemoved = await sweepReadersRemote(remoteDb, opts);
  const pagesRemoved = await sweepPagesRemote(remoteDb, watermark, opts);
  if (!opts.dryRun) await remoteDb.clearNeedsGc();
  return { skipped: false, pagesRemoved, readersRemoved };
}

async function sweepReadersRemote(remoteDb: RemoteRqliteDb, opts: SweepOptions): Promise<number> {
  let count = 0;
  for (const readerId of await remoteDb.expiredReaderIds()) {
    if (opts.dryRun) {
      console.log(`would remove expired reader lease: ${readerId}`);
    } else {
      await remoteDb.deleteReader(readerId);
      if (opts.verbose) console.log(`removed expired reader lease: ${readerId}`);
    }
    count++;
  }
  return count;
}

async function sweepPagesRemote(
  remoteDb: RemoteRqliteDb,
  watermark: number,
  opts: SweepOptions,
): Promise<number> {
  let count = 0;
  for (const { pageNo, version } of await remoteDb.garbagePages(watermark)) {
    if (opts.dryRun) {
      console.log(`would delete: page ${pageNo} version ${version}`);
    } else {
      await remoteDb.deleteGarbagePage(pageNo, version);
      if (opts.verbose) console.log(`deleted: page ${pageNo} version ${version}`);
    }
    count++;
  }
  return count;
}
