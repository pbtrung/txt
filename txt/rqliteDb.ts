// Creates (or reopens) the rqlite page-store schema (docs/data_model.md's
// "rqlite Page Store") and seeds it with one admin account whose pages hold
// a migrated user SQLCipher database. commit() implements the schema's own
// documented commit pattern -- only pages that actually changed since the
// last commit get a new version row, so resuming a run doesn't blow up the
// output size rewriting every page on every document.

import { existsSync, readFileSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { SqliteDb } from "./sqlite.ts";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE rate_tiers (
  tier_id TEXT    PRIMARY KEY,
  rate    INTEGER NOT NULL,
  burst   INTEGER NOT NULL
);

CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  rate_tier  TEXT NOT NULL DEFAULT 'free' REFERENCES rate_tiers(tier_id),
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

export interface RateTier {
  tierId: string;
  rate: number;
  burst: number;
}

export interface SeedResult {
  userId: string;
  /** null when resuming an admin a prior run already created -- the raw key was already printed once. */
  apiKeyRaw: string | null;
}

interface DbMeta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
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

  /** Reuses an existing admin account (resume) or seeds a fresh one. */
  ensureAdmin(tier: RateTier): SeedResult {
    const existingUserId = this.findExistingAdmin();
    if (existingUserId) return { userId: existingUserId, apiKeyRaw: null };
    return this.seedAdmin(tier);
  }

  private findExistingAdmin(): string | null {
    const stmt = this.db.prepare("SELECT user_id FROM users LIMIT 1;");
    const userId = stmt.step() ? stmt.columnText(0) : null;
    stmt.finalize();
    return userId;
  }

  private seedAdmin(tier: RateTier): SeedResult {
    const userId = randomUUID();
    const nowMs = Date.now();
    this.insertRateTier(tier);
    this.insertUser(userId, tier.tierId, nowMs);
    const apiKeyRaw = this.insertApiKey(userId, nowMs);
    return { userId, apiKeyRaw };
  }

  private insertRateTier(tier: RateTier): void {
    this.db.run("INSERT INTO rate_tiers (tier_id, rate, burst) VALUES (?, ?, ?);", (s) => {
      s.bindText(1, tier.tierId);
      s.bindInt64(2, tier.rate);
      s.bindInt64(3, tier.burst);
    });
  }

  private insertUser(userId: string, tierId: string, nowMs: number): void {
    this.db.run(
      "INSERT INTO users (user_id, role, rate_tier, disabled, created_at) VALUES (?, 'admin', ?, 0, ?);",
      (s) => {
        s.bindText(1, userId);
        s.bindText(2, tierId);
        s.bindInt64(3, nowMs);
      },
    );
  }

  private insertApiKey(userId: string, nowMs: number): string {
    const apiKeyRaw = randomBytes(32).toString("base64url");
    const keyHash = createHash("sha3-256").update(apiKeyRaw).digest("base64");
    this.db.run("INSERT INTO api_keys (user_id, key_hash, created_at) VALUES (?, ?, ?);", (s) => {
      s.bindText(1, userId);
      s.bindText(2, keyHash);
      s.bindInt64(3, nowMs);
    });
    return apiKeyRaw;
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

  close(): void {
    this.db.close();
  }
}
