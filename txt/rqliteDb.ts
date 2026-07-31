// Creates (or reopens) the rqlite page-store schema (docs/data_model.md's
// "rqlite Page Store") and seeds it with one admin account whose pages hold
// a migrated user SQLCipher database. commit() implements the schema's own
// documented commit pattern -- only pages that actually changed since the
// last commit get a new version row, so resuming a run doesn't blow up the
// output size rewriting every page on every document.

import { existsSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { SqliteDb, type Statement } from "./sqlite.ts";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(user_id),
  key_hash   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE pages (
  db_id    TEXT    NOT NULL REFERENCES users(user_id),
  page_no  INTEGER NOT NULL,
  version  INTEGER NOT NULL,
  data     BLOB    NOT NULL,
  PRIMARY KEY (db_id, page_no, version)
);

CREATE INDEX idx_pages_lookup ON pages (db_id, page_no, version DESC);

CREATE TABLE db_meta (
  db_id           TEXT PRIMARY KEY REFERENCES users(user_id),
  current_version INTEGER NOT NULL,
  page_count      INTEGER NOT NULL,
  page_size       INTEGER NOT NULL,
  needs_gc        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE active_readers (
  db_id            TEXT    NOT NULL REFERENCES users(user_id),
  reader_id        TEXT    NOT NULL,
  snapshot_version INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  PRIMARY KEY (db_id, reader_id)
);

CREATE TABLE gc_runs (
  day_id     INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL
);
`;

export interface SeedResult {
  userId: string;
  /** false when resuming an admin a prior run already created. */
  created: boolean;
}

interface DbMeta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
}

/** SHA3-256 of apiKey as given, base64-encoded -- matches the OpenResty auth layer's hash. */
export function hashApiKey(apiKey: string): string {
  return createHash("sha3-256").update(apiKey).digest("base64");
}

export class RqliteDb {
  private readonly db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.db = db;
  }

  /**
   * This WASM build has no real-filesystem VFS -- sqlite3_open_v2 only ever
   * touches MEMFS, so the only way this database persists across separate
   * process runs (what makes a crashed run resumable) is preloading the
   * real file's bytes back in on open, and flushing them back out after
   * every commit. See SqliteDb.flushToHost.
   */
  static async open(path: string): Promise<RqliteDb> {
    const isNew = !existsSync(path);
    const preload = isNew ? undefined : readFileSync(path);
    const db = await SqliteDb.open(path, { preload });
    const rqliteDb = new RqliteDb(db);
    if (isNew) {
      db.exec(SCHEMA);
      db.flushToHost();
    }
    return rqliteDb;
  }

  /**
   * Opens an rqlite_txt.db that must already exist (unlike open(), which
   * creates one) -- for tools that inspect or clean up an existing output
   * rather than produce one. readOnly leaves the real file untouched.
   */
  static async openExisting(path: string, opts: { readOnly?: boolean } = {}): Promise<RqliteDb> {
    if (!existsSync(path)) throw new Error(`${path}: no such file`);
    const db = await SqliteDb.open(path, { preload: readFileSync(path), readOnly: opts.readOnly });
    return new RqliteDb(db);
  }

  /**
   * Reuses an existing admin account (resume) or seeds a fresh one, hashing
   * apiKey (the caller-supplied out_creds.json api_key, base64) into
   * api_keys.key_hash exactly the way the OpenResty auth layer hashes a
   * bearer token -- SHA3-256 of the string as given, base64-encoded. When
   * resuming, a non-empty apiKey still overwrites the stored key_hash --
   * out_creds.json is the source of truth on every run, not just the first.
   */
  ensureAdmin(apiKey: string): SeedResult {
    const existingUserId = this.findAdminUserId();
    if (existingUserId) {
      if (apiKey) this.updateApiKeyHash(existingUserId, apiKey);
      return { userId: existingUserId, created: false };
    }
    return this.seedAdmin(apiKey);
  }

  /** The one admin account this tool ever creates, or null if none exists yet. */
  findAdminUserId(): string | null {
    const stmt = this.db.prepare("SELECT user_id FROM users LIMIT 1;");
    const userId = stmt.step() ? stmt.columnText(0) : null;
    stmt.finalize();
    return userId;
  }

  private seedAdmin(apiKey: string): SeedResult {
    const userId = randomUUID();
    const nowMs = Date.now();
    this.insertUser(userId, nowMs);
    this.insertApiKey(userId, nowMs, apiKey);
    return { userId, created: true };
  }

  private insertUser(userId: string, nowMs: number): void {
    this.db.run(
      "INSERT INTO users (user_id, role, disabled, created_at) VALUES (?, 'admin', 0, ?);",
      (s) => {
        s.bindText(1, userId);
        s.bindInt64(2, nowMs);
      },
    );
  }

  private insertApiKey(userId: string, nowMs: number, apiKey: string): void {
    this.db.run("INSERT INTO api_keys (user_id, key_hash, created_at) VALUES (?, ?, ?);", (s) => {
      s.bindText(1, userId);
      s.bindText(2, hashApiKey(apiKey));
      s.bindInt64(3, nowMs);
    });
  }

  private updateApiKeyHash(userId: string, apiKey: string): void {
    this.db.run("UPDATE api_keys SET key_hash = ? WHERE user_id = ?;", (s) => {
      s.bindText(1, hashApiKey(apiKey));
      s.bindText(2, userId);
    });
  }

  /** 0 if this tenant has never committed a page yet. */
  currentVersion(userId: string): number {
    const stmt = this.db.prepare("SELECT current_version FROM db_meta WHERE db_id = ?;");
    stmt.bindText(1, userId);
    const version = stmt.step() ? Number(stmt.columnInt64(0)) : 0;
    stmt.finalize();
    return version;
  }

  /** Reconstructs the tenant's current full byte image from its versioned pages. */
  latestPages(userId: string): { bytes: Buffer; pageSize: number } {
    const meta = this.readMeta(userId);
    const pages: Buffer[] = [];
    for (let pageNo = 1; pageNo <= meta.pageCount; pageNo++) {
      pages.push(this.mustReadPageAtOrBefore(userId, pageNo, meta.currentVersion));
    }
    return { bytes: Buffer.concat(pages), pageSize: meta.pageSize };
  }

  private readMeta(userId: string): DbMeta {
    const stmt = this.db.prepare(
      "SELECT current_version, page_count, page_size FROM db_meta WHERE db_id = ?;",
    );
    stmt.bindText(1, userId);
    if (!stmt.step()) throw new Error(`no db_meta row for ${userId}`);
    const meta = {
      currentVersion: Number(stmt.columnInt64(0)),
      pageCount: Number(stmt.columnInt64(1)),
      pageSize: Number(stmt.columnInt64(2)),
    };
    stmt.finalize();
    return meta;
  }

  /**
   * Commits a new full snapshot: only pages whose bytes differ from what's
   * already at or before oldVersion get a new row, at db_meta.current_version+1
   * -- the same guarded-write pattern docs/data_model.md describes, just
   * without the concurrent-writer CAS (this tool is always the sole writer).
   */
  commit(userId: string, pageSize: number, bytes: Uint8Array): void {
    const oldVersion = this.currentVersion(userId);
    const newVersion = oldVersion + 1;
    const pageCount = bytes.length / pageSize;
    for (let i = 0; i < pageCount; i++) {
      const pageNo = i + 1;
      const data = Buffer.from(bytes.subarray(i * pageSize, (i + 1) * pageSize));
      const previous = oldVersion > 0 ? this.readPageAtOrBefore(userId, pageNo, oldVersion) : null;
      if (!previous || !previous.equals(data)) this.insertPage(userId, pageNo, newVersion, data);
    }
    this.upsertMeta(userId, oldVersion, newVersion, pageCount, pageSize);
    this.db.flushToHost();
  }

  private readPageAtOrBefore(userId: string, pageNo: number, version: number): Buffer | null {
    const stmt = this.db.prepare(
      "SELECT data FROM pages WHERE db_id=? AND page_no=? AND version<=? ORDER BY version DESC LIMIT 1;",
    );
    stmt.bindText(1, userId);
    stmt.bindInt64(2, pageNo);
    stmt.bindInt64(3, version);
    const data = stmt.step() ? stmt.columnBlob(0) : null;
    stmt.finalize();
    return data;
  }

  private mustReadPageAtOrBefore(userId: string, pageNo: number, version: number): Buffer {
    const data = this.readPageAtOrBefore(userId, pageNo, version);
    if (!data)
      throw new Error(`missing page ${pageNo} for ${userId} at or before version ${version}`);
    return data;
  }

  private insertPage(userId: string, pageNo: number, version: number, data: Uint8Array): void {
    this.db.run("INSERT INTO pages (db_id, page_no, version, data) VALUES (?, ?, ?, ?);", (s) => {
      s.bindText(1, userId);
      s.bindInt64(2, pageNo);
      s.bindInt64(3, version);
      s.bindBlob(4, data);
    });
  }

  private upsertMeta(
    userId: string,
    oldVersion: number,
    newVersion: number,
    pageCount: number,
    pageSize: number,
  ): void {
    if (oldVersion === 0) {
      this.db.run(
        "INSERT INTO db_meta (db_id, current_version, page_count, page_size, needs_gc) VALUES (?, ?, ?, ?, 0);",
        (s) => {
          s.bindText(1, userId);
          s.bindInt64(2, newVersion);
          s.bindInt64(3, pageCount);
          s.bindInt64(4, pageSize);
        },
      );
      return;
    }
    this.db.run(
      "UPDATE db_meta SET current_version=?, page_count=?, needs_gc=1 WHERE db_id=? AND current_version=?;",
      (s) => {
        s.bindInt64(1, newVersion);
        s.bindInt64(2, pageCount);
        s.bindText(3, userId);
        s.bindInt64(4, oldVersion);
      },
    );
  }

  /** True if a writer has committed since the last GC sweep cleared this flag. */
  needsGc(userId: string): boolean {
    const stmt = this.db.prepare("SELECT needs_gc FROM db_meta WHERE db_id=?;");
    stmt.bindText(1, userId);
    const flag = stmt.step() ? stmt.columnInt64(0) : 0n;
    stmt.finalize();
    return flag !== 0n;
  }

  clearNeedsGc(userId: string): void {
    this.db.run("UPDATE db_meta SET needs_gc=0 WHERE db_id=?;", (s) => s.bindText(1, userId));
  }

  /** INSERT OR IGNORE into gc_runs for today -- bookkeeping only, doesn't gate this run. */
  recordGcRun(): void {
    const dayId = Math.floor(Date.now() / 86400000);
    this.db.run("INSERT OR IGNORE INTO gc_runs (day_id, started_at) VALUES (?, ?);", (s) => {
      s.bindInt64(1, dayId);
      s.bindInt64(2, Date.now());
    });
  }

  /** Oldest snapshot version any non-expired reader still needs, or current_version if none. */
  gcWatermark(userId: string): number {
    const stmt = this.db.prepare(
      "SELECT MIN(snapshot_version) FROM active_readers WHERE db_id=? AND lease_expires_at > ?;",
    );
    stmt.bindText(1, userId);
    stmt.bindInt64(2, Date.now());
    stmt.step();
    const watermark = stmt.columnIsNull(0) ? null : Number(stmt.columnInt64(0));
    stmt.finalize();
    return watermark ?? this.currentVersion(userId);
  }

  /** Registers a reader's pinned snapshot -- what a real read transaction's BEGIN would do. */
  insertActiveReader(
    userId: string,
    readerId: string,
    snapshotVersion: number,
    leaseExpiresAtMs: number,
  ): void {
    this.db.run(
      "INSERT INTO active_readers (db_id, reader_id, snapshot_version, lease_expires_at) VALUES (?, ?, ?, ?);",
      (s) => {
        s.bindText(1, userId);
        s.bindText(2, readerId);
        s.bindInt64(3, snapshotVersion);
        s.bindInt64(4, leaseExpiresAtMs);
      },
    );
  }

  expiredReaderIds(userId: string): string[] {
    const stmt = this.db.prepare(
      "SELECT reader_id FROM active_readers WHERE db_id=? AND lease_expires_at<?;",
    );
    stmt.bindText(1, userId);
    stmt.bindInt64(2, Date.now());
    const ids: string[] = [];
    while (stmt.step()) ids.push(stmt.columnText(0));
    stmt.finalize();
    return ids;
  }

  deleteReader(userId: string, readerId: string): void {
    this.db.run("DELETE FROM active_readers WHERE db_id=? AND reader_id=?;", (s) => {
      s.bindText(1, userId);
      s.bindText(2, readerId);
    });
  }

  /**
   * Page (page_no, version) pairs safe to delete: superseded within their own
   * page's history at or before the watermark, plus -- only when nothing is
   * pinned to an older snapshot than the current one -- pages that no longer
   * exist at all (e.g. after a VACUUM shrinks page_count). That second class
   * only applies when watermark == currentVersion: db_meta.page_count is
   * never versioned (see docs/data_model.md), so "beyond the current page
   * count" is only meaningful relative to the *current* state, not an older
   * pinned snapshot that might have had more pages before the shrink.
   */
  garbagePages(userId: string, watermark: number): { pageNo: number; version: number }[] {
    const rows = this.supersededPages(userId, watermark);
    if (watermark >= this.currentVersion(userId))
      rows.push(...this.trailingPages(userId, watermark));
    return rows;
  }

  private supersededPages(
    userId: string,
    watermark: number,
  ): { pageNo: number; version: number }[] {
    const stmt = this.db.prepare(`
      SELECT page_no, version FROM pages AS p
      WHERE db_id = ?
        AND version < (
          SELECT MAX(version) FROM pages AS p2
          WHERE p2.db_id = p.db_id AND p2.page_no = p.page_no AND p2.version <= ?
        );
    `);
    stmt.bindText(1, userId);
    stmt.bindInt64(2, watermark);
    return this.collectPageRows(stmt);
  }

  /** Rows for page_no's beyond the current page_count -- the file no longer has them at all. */
  private trailingPages(userId: string, watermark: number): { pageNo: number; version: number }[] {
    const pageCount = this.readMeta(userId).pageCount;
    const stmt = this.db.prepare(
      "SELECT page_no, version FROM pages WHERE db_id=? AND page_no>? AND version<=?;",
    );
    stmt.bindText(1, userId);
    stmt.bindInt64(2, pageCount);
    stmt.bindInt64(3, watermark);
    return this.collectPageRows(stmt);
  }

  private collectPageRows(stmt: Statement): { pageNo: number; version: number }[] {
    const rows: { pageNo: number; version: number }[] = [];
    while (stmt.step())
      rows.push({ pageNo: Number(stmt.columnInt64(0)), version: Number(stmt.columnInt64(1)) });
    stmt.finalize();
    return rows;
  }

  deleteGarbagePage(userId: string, pageNo: number, version: number): void {
    this.db.run("DELETE FROM pages WHERE db_id=? AND page_no=? AND version=?;", (s) => {
      s.bindText(1, userId);
      s.bindInt64(2, pageNo);
      s.bindInt64(3, version);
    });
  }

  /** Flushes any writes made through the mutating methods above to the real file. */
  flush(): void {
    this.db.flushToHost();
  }

  /** Rebuilds rqlite_txt.db's own file to reclaim space and defragment, then flushes it. */
  vacuum(): void {
    this.db.exec("VACUUM;");
    this.db.flushToHost();
  }

  close(): void {
    this.db.close();
  }
}
