// The five *Command classes behind txt.ts's five flags
// (--clean-bucket/--collect-garbage/--vacuum/--migrate/--test-perf), plus
// the two small single-consumer helpers only --migrate needs (randomPath,
// mapLimit -- each used to be its own file; nothing else ever imported
// them, so there was no reuse to lose by inlining them here). Kept in one
// file rather than five: each command was already its own small class, and
// every one of them repeated the identical opts/constructor/log()
// boilerplate below -- the Command base class is what that duplication
// actually earns, not a reason by itself to merge unrelated logic.

import { randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import {
  loadInCreds,
  loadOutCreds,
  loadPerfCreds,
  rootKeyBytes,
  type OutCreds,
  type PerfCreds,
} from "./creds.ts";
import { BlobCipher } from "./blobCipher.ts";
import { R2Client } from "./r2.ts";
import {
  OldVault,
  resolveTxtMetadataMap,
  type OldTxtRow,
  type OldPartRow,
  type TxtMetadataMap,
} from "./oldVault.ts";
import { UserDb } from "./userDb.ts";
import { RqliteDb, hashApiKey } from "./rqliteDb.ts";
import { SqliteDb } from "./sqlite.ts";
import { RqliteHttpClient, resultRows } from "./rqliteHttpClient.ts";
import { loadWasm } from "./wasm.ts";
import { registerRemoteVfs, type RemoteVfsStats } from "./remoteVfs.ts";

/**
 * Shared by every command below: owns `opts` and the verbose-gated `log()`
 * each one used to repeat identically. `progress()` is for output that
 * should always print regardless of `--verbose` -- only `TestPerfCommand`
 * uses it today, but it's here on the base rather than duplicated again the
 * next time a command wants the same always-on/verbose-only split.
 */
abstract class Command<TOpts extends { verbose: boolean }> {
  protected readonly opts: TOpts;

  constructor(opts: TOpts) {
    this.opts = opts;
  }

  protected log(message: string): void {
    if (this.opts.verbose) console.log(message);
  }

  protected progress(message: string): void {
    console.log(message);
  }
}

// ===========================================================================
// --clean-bucket: deletes every R2/S3 object not referenced by any
// txt_parts.path in the migrated user's database. Read-only against
// rqlite_txt.db -- only the bucket is ever written to.
// ===========================================================================

export interface CleanBucketOptions {
  credsPath: string;
  dbPath: string;
  dryRun: boolean;
  verbose: boolean;
}

export class CleanBucketCommand extends Command<CleanBucketOptions> {
  async run(): Promise<void> {
    const creds = loadInCreds(this.opts.credsPath);
    const r2 = new R2Client(creds.r2_config);
    const referenced = await this.referencedPaths(rootKeyBytes(creds));
    this.log(`${referenced.size} object path(s) referenced by txt_parts`);
    const allKeys = await r2.list();
    this.log(`${allKeys.length} object(s) in the bucket`);
    const orphans = allKeys.filter((key) => !referenced.has(key));
    await this.handleOrphans(r2, orphans);
    this.report(allKeys.length, referenced.size, orphans.length);
  }

  private async referencedPaths(rawKey: Buffer): Promise<Set<string>> {
    const rqliteDb = await RqliteDb.openExisting(this.opts.dbPath, { readOnly: true });
    const userId = rqliteDb.findAdminUserId();
    if (!userId) {
      rqliteDb.close();
      return new Set();
    }
    const { bytes } = rqliteDb.latestPages(userId);
    rqliteDb.close();
    return this.readTxtPartPaths(bytes, rawKey);
  }

  private async readTxtPartPaths(bytes: Uint8Array, rawKey: Buffer): Promise<Set<string>> {
    const userDb = await SqliteDb.open("/clean-bucket-user.db", {
      preload: bytes,
      rawKey,
      readOnly: true,
    });
    const stmt = userDb.prepare("SELECT path FROM txt_parts;");
    const paths = new Set<string>();
    while (stmt.step()) paths.add(stmt.columnText(0));
    stmt.finalize();
    userDb.close();
    return paths;
  }

  private async handleOrphans(r2: R2Client, orphans: string[]): Promise<void> {
    for (const key of orphans) {
      if (this.opts.dryRun) {
        console.log(`would delete: ${key}`);
        continue;
      }
      await r2.delete(key);
      this.log(`deleted: ${key}`);
    }
  }

  private report(total: number, referenced: number, orphanCount: number): void {
    const verb = this.opts.dryRun ? "would delete" : "deleted";
    console.log(
      `\n${total} object(s) in bucket, ${referenced} referenced, ${orphanCount} orphan(s) ${verb}`,
    );
  }
}

// ===========================================================================
// --collect-garbage: sweeps rqlite_txt.db's own page-store tables -- page
// versions superseded before the GC watermark, and expired active_readers
// leases -- per docs/data_model.md's "rqlite Page Store". Only ever touches
// rqlite_txt.db; the R2/S3 bucket is untouched (that's what --clean-bucket
// is for). sweepGarbage() is the reusable sweep itself (also used by
// --vacuum, on its own already-open connection); CollectGarbageCommand is
// just the standalone-command wrapper around it.
// ===========================================================================

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

export class CollectGarbageCommand extends Command<CollectGarbageOptions> {
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

// ===========================================================================
// --vacuum: rebuilds the admin's user SQLCipher database first (reclaiming
// space from deleted rows, defragmenting), commits the result back into
// rqlite_txt.db as a new version, collects the stale page versions that
// commit (and anything else) left behind, then rebuilds rqlite_txt.db
// itself -- in that order, since SQLite's VACUUM only reclaims space
// already-deleted rows freed up, not rows that are merely superseded but
// still live.
// ===========================================================================

export interface VacuumOptions {
  credsPath: string;
  dbPath: string;
  verbose: boolean;
}

export class VacuumCommand extends Command<VacuumOptions> {
  async run(): Promise<void> {
    const creds = loadOutCreds(this.opts.credsPath);
    const rqliteDb = await RqliteDb.openExisting(this.opts.dbPath);
    try {
      const userId = rqliteDb.findAdminUserId();
      if (!userId) {
        console.log("no admin account found; nothing to vacuum");
        return;
      }
      await this.vacuumUserDb(rqliteDb, userId, rootKeyBytes(creds));
      this.collectGarbage(rqliteDb, userId);
      this.vacuumRqliteDb(rqliteDb);
    } finally {
      rqliteDb.close();
    }
  }

  private async vacuumUserDb(rqliteDb: RqliteDb, userId: string, rawKey: Buffer): Promise<void> {
    const before = rqliteDb.latestPages(userId);
    this.log(`user database: ${before.bytes.length} bytes before VACUUM`);
    const userDb = await SqliteDb.open("/vacuum-user.db", { preload: before.bytes, rawKey });
    userDb.exec("VACUUM;");
    const after = userDb.readBytes();
    userDb.close();
    this.log(`user database: ${after.length} bytes after VACUUM`);
    rqliteDb.commit(userId, before.pageSize, after);
  }

  /** Rewriting the user db just superseded a lot of pages -- collect them before vacuuming rqlite_txt.db. */
  private collectGarbage(rqliteDb: RqliteDb, userId: string): void {
    const result = sweepGarbage(rqliteDb, userId, { dryRun: false, verbose: this.opts.verbose });
    if (!result.skipped) this.log(`collected ${result.pagesRemoved} stale page version(s)`);
  }

  private vacuumRqliteDb(rqliteDb: RqliteDb): void {
    const before = statSync(this.opts.dbPath).size;
    rqliteDb.vacuum();
    const after = statSync(this.opts.dbPath).size;
    console.log(`\nrqlite_txt.db: ${before} -> ${after} bytes`);
  }
}

// ===========================================================================
// --migrate: decrypt the old shared-vault schema, re-encrypt each part's
// content under a fresh per-document key at a fresh R2/S3 path, build the
// new user's SQLCipher database, and commit it into rqlite_txt.db after
// every document finishes -- the temporary user database only ever lives in
// memory, so committing early and often is what makes a run resumable after
// a crash, not anything the in-memory side keeps track of.
// ===========================================================================

const PART_CONCURRENCY = 16;

const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const RANDOM_PATH_BYTES = 32;
const RANDOM_PATH_CHARS = Math.ceil((RANDOM_PATH_BYTES * 8) / 5); // 52

/**
 * Crockford base32 (lowercase, excludes i/l/o/u), fixed-length encoding of
 * 32 random bytes -- used as a fresh R2/S3 object key per migrated part.
 * Only MigrateCommand needs this.
 */
function randomPath(): string {
  let bits = 0n;
  for (const b of randomBytes(RANDOM_PATH_BYTES)) bits = (bits << 8n) | BigInt(b);
  bits <<= BigInt(RANDOM_PATH_CHARS * 5 - RANDOM_PATH_BYTES * 8);
  let out = "";
  for (let i = RANDOM_PATH_CHARS - 1; i >= 0; i--)
    out += BASE32_ALPHABET[Number((bits >> BigInt(i * 5)) & 0x1fn)];
  return out;
}

/** Bounded-concurrency map. Only MigrateCommand needs this (re-encrypting parts). */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface MigrateOptions {
  inCredsPath: string;
  inPath: string;
  outCredsPath: string;
  outPath: string;
  noDelete: boolean;
  verbose: boolean;
}

interface MigrateSummary {
  documents: number;
  partsMigrated: number;
}

export class MigrateCommand extends Command<MigrateOptions> {
  private readonly summary: MigrateSummary = { documents: 0, partsMigrated: 0 };
  private readonly metadataCache = new Map<bigint, TxtMetadataMap>();
  private cipher!: BlobCipher;
  private r2!: R2Client;
  private oldVault!: OldVault;
  private userDb!: UserDb;
  private rqliteDb!: RqliteDb;
  private userId!: string;

  async run(): Promise<void> {
    const inCreds = loadInCreds(this.opts.inCredsPath);
    const outCreds = loadOutCreds(this.opts.outCredsPath);
    this.cipher = await BlobCipher.create();
    this.r2 = new R2Client(inCreds.r2_config);
    this.oldVault = await OldVault.open(this.opts.inPath);
    await this.openOutput(outCreds);
    try {
      const umks = this.oldVault.findDecryptableUmks(this.cipher, rootKeyBytes(inCreds));
      this.log(`decrypted ${umks.size} owner umk(s) with the supplied root key`);
      if (umks.size === 0)
        throw new Error("no umk_store row decrypted with the supplied user_root_key");
      await this.migrateAll(umks);
    } finally {
      this.oldVault.close();
      this.rqliteDb.close();
    }
    this.report();
  }

  private async openOutput(outCreds: OutCreds): Promise<void> {
    this.rqliteDb = await RqliteDb.open(this.opts.outPath);
    const { userId, created } = this.rqliteDb.ensureAdmin(outCreds.api_key);
    this.userId = userId;
    const version = this.rqliteDb.currentVersion(userId);
    const rawKey = rootKeyBytes(outCreds);
    if (version === 0) {
      this.userDb = await UserDb.create(rawKey);
      this.commitProgress(); // baseline version 1 -- schema only, no documents yet
    } else {
      this.log(`resuming from existing output at version ${version}`);
      this.userDb = await UserDb.resume(rawKey, this.rqliteDb.latestPages(userId).bytes);
    }
    this.announceAdmin(userId, created);
  }

  private announceAdmin(userId: string, created: boolean): void {
    if (created) {
      console.log(
        `\nnew admin user_id: ${userId} (API key hash seeded from out_creds.json's api_key)`,
      );
    } else {
      this.log(`reusing existing admin user_id: ${userId} (API key hash refreshed)`);
    }
  }

  private async migrateAll(umks: Map<bigint, Buffer>): Promise<void> {
    const rows = this.oldVault.listTxt(new Set(umks.keys()));
    const alreadyDone = this.userDb.countTxt();
    if (alreadyDone > 0) this.log(`skipping ${alreadyDone} already-committed document(s)`);
    for (const row of rows.slice(alreadyDone)) {
      await this.migrateDocument(row, umks.get(row.userId)!);
      this.summary.documents++;
      this.log(
        `migrated txt ${row.txtId} (${alreadyDone + this.summary.documents}/${rows.length})`,
      );
    }
  }

  private async migrateDocument(row: OldTxtRow, umk: Buffer): Promise<void> {
    const oldTxtKey = this.cipher.decrypt(umk, row.txtKeyBlob);
    const metadataMap = await this.metadataFor(row.userId, umk);
    const entry = metadataMap[String(row.txtId)] ?? { name: `untitled-${row.txtId}` };
    const newTxtKey = randomBytes(128);
    const metadataBuf = entry.metadata
      ? brotliCompressSync(Buffer.from(JSON.stringify(entry.metadata)))
      : null;
    const newTxtId = this.userDb.insertTxt(newTxtKey, entry.name, metadataBuf, Date.now());
    const parts = this.oldVault.listParts(row.txtId);
    this.log(`txt ${row.txtId} -> ${newTxtId} "${entry.name}": migrating ${parts.length} part(s)`);
    const oldPaths = await mapLimit(parts, PART_CONCURRENCY, (part) =>
      this.migratePart(part, newTxtId, oldTxtKey, newTxtKey),
    );
    this.commitProgress();
    if (!this.opts.noDelete) await this.deleteOldObjects(oldPaths);
  }

  private commitProgress(): void {
    const snap = this.userDb.snapshot();
    this.rqliteDb.commit(this.userId, snap.pageSize, snap.bytes);
    this.log(
      `committed progress (${snap.pageCount} pages at version ${this.rqliteDb.currentVersion(this.userId)})`,
    );
  }

  private async deleteOldObjects(oldPaths: (string | null)[]): Promise<void> {
    const paths = oldPaths.filter((p): p is string => p !== null);
    await mapLimit(paths, PART_CONCURRENCY, async (oldPath) => {
      await this.r2.delete(oldPath);
      this.log(`  deleted old object ${oldPath}`);
    });
  }

  private async metadataFor(userId: bigint, umk: Buffer): Promise<TxtMetadataMap> {
    const cached = this.metadataCache.get(userId);
    if (cached) return cached;
    const raw = this.oldVault.metadataRaw(userId);
    this.log(`resolving metadata map for owner ${userId}${raw ? "" : " (none found)"}`);
    const map = raw
      ? await resolveTxtMetadataMap(
          this.cipher,
          this.r2,
          this.cipher.decrypt(umk, raw.keyBlob),
          raw.content,
        )
      : {};
    this.metadataCache.set(userId, map);
    return map;
  }

  /**
   * Returns this part's old path on success (deletion is deferred until the
   * whole document commits), or null if there was nothing new to do. A
   * failure here propagates all the way up and aborts the run -- a document
   * only ever commits once every one of its parts has succeeded, so letting
   * one bad part abort cleanly (rather than silently leaving a document
   * partially migrated) is what keeps "resume" meaningful: whatever's
   * already committed is complete, and the rest just needs a re-run once
   * whatever caused the failure is fixed.
   */
  private async migratePart(
    part: OldPartRow,
    newTxtId: bigint,
    oldTxtKey: Buffer,
    newTxtKey: Buffer,
  ): Promise<string | null> {
    if (this.userDb.hasPart(newTxtId, part.partNum)) {
      this.log(`  part ${part.partNum}: already present, skipping`);
      return null;
    }
    return this.reencryptPart(part, newTxtId, oldTxtKey, newTxtKey);
  }

  private async reencryptPart(
    part: OldPartRow,
    newTxtId: bigint,
    oldTxtKey: Buffer,
    newTxtKey: Buffer,
  ): Promise<string> {
    const oldPath = this.cipher.decrypt(oldTxtKey, part.pathBlob).toString("ascii");
    this.log(`  part ${part.partNum}: downloading ${oldPath}`);
    const object = await this.r2.get(oldPath);
    const plaintext = brotliDecompressSync(this.cipher.decrypt(oldTxtKey, object));
    const newPath = randomPath();
    this.log(`  part ${part.partNum}: uploading ${newPath}`);
    await this.r2.put(newPath, this.cipher.encrypt(newTxtKey, brotliCompressSync(plaintext)));
    this.userDb.insertPart(newTxtId, part.partNum, newPath);
    this.summary.partsMigrated++;
    this.log(`  part ${part.partNum}: inserted (txt_id ${newTxtId})`);
    return oldPath;
  }

  private report(): void {
    console.log(
      `\nmigrated ${this.summary.documents} documents, ${this.summary.partsMigrated} parts`,
    );
  }
}

// ===========================================================================
// --test-perf: opens a real, remote user database lazily -- one page at a
// time, over real HTTP to a live OpenResty+rqlite deployment -- instead of
// the "read every page, build the full db in memory" model every other
// command here uses (RqliteDb.latestPages/UserDb.resume). Runs a handful of
// SELECTs against it and reports how many network round trips that
// actually cost, to make the tradeoff against the full-preload model
// measurable rather than assumed.
//
// Not covered by a committed end-to-end test: txt/rqliteHttpClient.test.ts
// covers the real HTTP layer (main thread only, no worker) and
// txt/remoteVfs.test.ts covers the lazy VFS's paging/caching/decryption
// (fake synchronous fetchPage, no network), but the real worker+Atomics+HTTP
// round trip this file wires together wasn't verified end-to-end -- real
// network I/O issued by a worker thread while the main thread blocks in
// Atomics.wait was found to stall indefinitely in at least one sandboxed
// dev environment (a non-network worker response over the same bridge
// worked fine, ruling out Atomics.wait/SharedArrayBuffer mechanics
// themselves). Verify this specific combination manually against a real
// deployment before relying on it somewhere new.
// ===========================================================================

const BACKED_PATH = "/remote-user.db";
const CONTROL_STATUS = 0;
const CONTROL_LEN = 1;
const STATUS_ERROR = 2;
const FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_QUERIES = [
  "SELECT COUNT(*) FROM txt;",
  "SELECT id, name FROM txt ORDER BY last_accessed DESC LIMIT 10;",
  "SELECT id, name, metadata FROM txt LIMIT 1;",
  "SELECT COUNT(*) FROM txt_parts;",
  "SELECT txt_id, part_num, path FROM txt_parts LIMIT 10;",
];

export interface TestPerfOptions {
  credsPath: string;
  verbose: boolean;
}

interface Meta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
}

export interface QueryReport {
  sql: string;
  rows: number;
  ms: number;
  roundtrips: number;
}

interface Bridge {
  fetchPage: (pageNo: number) => Uint8Array;
  terminate: () => Promise<void>;
}

export interface TestPerfResult {
  reports: QueryReport[];
  stats: RemoteVfsStats;
}

export class TestPerfCommand extends Command<TestPerfOptions> {
  async run(): Promise<TestPerfResult> {
    const creds = loadPerfCreds(this.opts.credsPath);
    this.progress(`Loaded creds from ${this.opts.credsPath} (rqlite_url=${creds.rqlite_url})`);
    const client = new RqliteHttpClient(creds.rqlite_url, creds.api_key);

    this.progress("Resolving identity...");
    const targetDbId = await this.resolveTargetDbId(client, creds.api_key);
    this.progress(
      targetDbId
        ? `Resolved admin's own account: target_db_id=${targetDbId}`
        : "Resolved as a user-role key (db_id forced server-side)",
    );

    this.progress("Fetching db_meta...");
    const meta = await this.fetchMeta(client, targetDbId);
    this.progress(
      `db_meta: version=${meta.currentVersion} pages=${meta.pageCount} page_size=${meta.pageSize}`,
    );

    this.progress("Starting page-fetch worker...");
    const bridge = await this.startWorker(creds, targetDbId, meta);
    this.progress("Worker ready");
    try {
      return await this.openAndReport(creds, meta, bridge);
    } finally {
      await bridge.terminate();
    }
  }

  /**
   * GET_META/READ_PAGE are ordinary user-level statements, forced to the
   * caller's own db_id -- unless the key resolves to role='admin', which has
   * no implicit self and needs target_db_id named explicitly (see
   * auth_perms.lua). Rather than requiring the caller to already know its
   * own user_id, look it up the same way auth_perms.lua's own identity
   * resolution does: api_keys.key_hash -> users.user_id. This only works
   * for an admin key (RAW_QUERY is admin-only) -- for a genuine user-role
   * key it fails with the same "unknown statementId" 400 any other bogus
   * statementId gets, which is exactly how a plain user key is told apart
   * from an admin one here.
   */
  private async resolveTargetDbId(
    client: RqliteHttpClient,
    apiKey: string,
  ): Promise<string | undefined> {
    const batch = [
      { sql: "SELECT user_id FROM api_keys WHERE key_hash = ?", args: [hashApiKey(apiKey)] },
    ];
    try {
      const row = resultRows(await client.query("RAW_QUERY", batch))[0];
      return row ? String(row[0]) : undefined;
    } catch {
      return undefined; // not an admin key -- GET_META/READ_PAGE will force db_id server-side instead
    }
  }

  private async openAndReport(
    creds: PerfCreds,
    meta: Meta,
    bridge: Bridge,
  ): Promise<TestPerfResult> {
    const mod = await loadWasm();
    const { name, stats } = registerRemoteVfs(mod, {
      pageSize: meta.pageSize,
      pageCount: meta.pageCount,
      backedPath: BACKED_PATH,
      fetchPage: bridge.fetchPage,
    });
    this.progress("Opening database (read-only)...");
    const db = await SqliteDb.open(BACKED_PATH, {
      vfsName: name,
      rawKey: rootKeyBytes(creds),
      readOnly: true,
    });
    this.progress("Database opened\n");
    try {
      const reports = this.runQueries(db, stats);
      printSummary(reports, stats);
      return { reports, stats };
    } finally {
      db.close();
    }
  }

  private async fetchMeta(client: RqliteHttpClient, targetDbId: string | undefined): Promise<Meta> {
    const extra = targetDbId ? { target_db_id: targetDbId } : {};
    const row = resultRows(await client.query("GET_META", [{}], extra))[0];
    if (!row) throw new Error("GET_META returned no row -- has this account committed a db yet?");
    return { currentVersion: Number(row[0]), pageCount: Number(row[1]), pageSize: Number(row[2]) };
  }

  private async startWorker(
    creds: PerfCreds,
    targetDbId: string | undefined,
    meta: Meta,
  ): Promise<Bridge> {
    const controlSab = new SharedArrayBuffer(8);
    const dataSab = new SharedArrayBuffer(Math.max(meta.pageSize, 4096) + 4096);
    const control = new Int32Array(controlSab);
    const dataBuf = new Uint8Array(dataSab);
    const worker = new Worker(new URL("./remotePageWorker.ts", import.meta.url), {
      workerData: {
        rqliteUrl: creds.rqlite_url,
        apiKey: creds.api_key,
        targetDbId,
        snapshot: meta.currentVersion,
        controlSab,
        dataSab,
      },
    });
    await waitReady(worker);
    return {
      fetchPage: (pageNo) => this.fetchPageAndLog(worker, control, dataBuf, pageNo),
      terminate: () => worker.terminate().then(() => undefined),
    };
  }

  private fetchPageAndLog(
    worker: Worker,
    control: Int32Array,
    dataBuf: Uint8Array,
    pageNo: number,
  ): Uint8Array {
    const start = performance.now();
    const bytes = fetchPageSync(worker, control, dataBuf, pageNo);
    this.log(
      `  fetched page ${pageNo} (${bytes.length}b, ${(performance.now() - start).toFixed(1)}ms)`,
    );
    return bytes;
  }

  private runQueries(db: SqliteDb, stats: RemoteVfsStats): QueryReport[] {
    this.progress("\n--- --test-perf report ---");
    return DEFAULT_QUERIES.map((sql, i) => this.runOneQuery(db, stats, sql, i));
  }

  private runOneQuery(
    db: SqliteDb,
    stats: RemoteVfsStats,
    sql: string,
    index: number,
  ): QueryReport {
    this.progress(`[${index + 1}/${DEFAULT_QUERIES.length}] ${sql}`);
    const before = stats.roundtrips.length;
    const start = performance.now();
    const rows = execSelect(db, sql);
    const ms = performance.now() - start;
    const report = { sql, rows, ms, roundtrips: stats.roundtrips.length - before };
    this.progress(`  rows=${report.rows} roundtrips=${report.roundtrips} time=${ms.toFixed(1)}ms`);
    return report;
  }
}

function execSelect(db: SqliteDb, sql: string): number {
  const stmt = db.prepare(sql);
  let rows = 0;
  while (stmt.step()) rows++;
  stmt.finalize();
  return rows;
}

function waitReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("message", (msg: { type?: string }) => {
      if (msg?.type === "ready") resolve();
      else reject(new Error("unexpected first message from remote-page worker"));
    });
    worker.once("error", reject);
  });
}

function fetchPageSync(
  worker: Worker,
  control: Int32Array,
  dataBuf: Uint8Array,
  pageNo: number,
): Uint8Array {
  Atomics.store(control, CONTROL_STATUS, 0);
  worker.postMessage({ pageNo });
  if (Atomics.wait(control, CONTROL_STATUS, 0, FETCH_TIMEOUT_MS) === "timed-out") {
    throw new Error(`timed out fetching page ${pageNo}`);
  }
  const status = Atomics.load(control, CONTROL_STATUS);
  const bytes = dataBuf.slice(0, Atomics.load(control, CONTROL_LEN));
  if (status === STATUS_ERROR) throw new Error(Buffer.from(bytes).toString("utf8"));
  return bytes;
}

function printSummary(reports: QueryReport[], stats: RemoteVfsStats): void {
  const totalMs = reports.reduce((a, r) => a + r.ms, 0);
  const rtMs = stats.roundtrips.map((r) => r.ms);
  const sum = rtMs.reduce((a, b) => a + b, 0);
  console.log(`\ntotal query time: ${totalMs.toFixed(1)}ms across ${reports.length} queries`);
  console.log(`total roundtrips: ${stats.roundtrips.length} (distinct pages fetched)`);
  console.log(`bytes fetched: ${stats.bytesFetched}`);
  if (rtMs.length === 0) return;
  const avg = sum / rtMs.length;
  console.log(
    `roundtrip time: total=${sum.toFixed(1)}ms avg=${avg.toFixed(1)}ms ` +
      `min=${Math.min(...rtMs).toFixed(1)}ms max=${Math.max(...rtMs).toFixed(1)}ms`,
  );
}
