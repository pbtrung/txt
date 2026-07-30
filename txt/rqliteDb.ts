// Creates the rqlite page-store schema (docs/data_model.md's "rqlite Page
// Store") and seeds it with one freshly-generated admin account whose
// pages hold a migrated user SQLCipher database.

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
  apiKeyRaw: string;
}

export class RqliteDb {
  private readonly db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.db = db;
  }

  static async create(path: string): Promise<RqliteDb> {
    const db = await SqliteDb.open(path);
    db.exec(SCHEMA);
    return new RqliteDb(db);
  }

  /** Inserts the rate tier + a new admin user; returns its id and a fresh raw API key. */
  seedAdmin(tier: RateTier): SeedResult {
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

  /** Writes db_meta + one pages row per pageSize-byte chunk of bytes, all at version 1. */
  writePages(userId: string, pageSize: number, bytes: Uint8Array): void {
    const pageCount = bytes.length / pageSize;
    this.db.run(
      "INSERT INTO db_meta (db_id, current_version, page_count, page_size, needs_gc) VALUES (?, 1, ?, ?, 0);",
      (s) => {
        s.bindText(1, userId);
        s.bindInt64(2, pageCount);
        s.bindInt64(3, pageSize);
      },
    );
    for (let i = 0; i < pageCount; i++)
      this.insertPage(userId, i + 1, bytes.subarray(i * pageSize, (i + 1) * pageSize));
  }

  private insertPage(userId: string, pageNo: number, data: Uint8Array): void {
    this.db.run("INSERT INTO pages (db_id, page_no, version, data) VALUES (?, ?, 1, ?);", (s) => {
      s.bindText(1, userId);
      s.bindInt64(2, pageNo);
      s.bindBlob(3, data);
    });
  }

  close(): void {
    this.db.close();
  }
}
