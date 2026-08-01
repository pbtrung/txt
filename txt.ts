// --clean-bucket: deletes every R2 object not referenced by one account's
// txt_parts.path/txt_metadata.content, per in.db (a local sqlite snapshot of
// the schema documented in docs/data_model.md as of commit
// 1ed39d433365c39a6973303c171c7bb5510d7e3e -- NOT the InstantDB design docs
// currently in this repo, which are unrelated). TypeScript port of the
// read-only half of that commit's txt/owner.py + txt/bucket.py.
//
// Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
// @ts-ignore -- no type declarations beyond `declare function Sqlite3Wasm(): Promise<any>`
import Sqlite3Wasm from "./sqlcipher/sqlcipher.js";

// ---------------------------------------------------------------------------
// Constants (subset of txt/constants.py needed for decrypt-only operation)
// ---------------------------------------------------------------------------

const MAGIC = [0x54, 0x58];
const VERSION_MAJOR = 0x01;
const SALT_LEN = 64;
const TAG_LEN = 64;
const KEY_LEN = 64;
const IV_LEN = 64;
const OKM_LEN = KEY_LEN + IV_LEN; // 128
const HEADER_LEN = 4; // magic(2) + version(2)
const AD_LEN = HEADER_LEN + SALT_LEN; // 68
const BLOB_MIN_LEN = AD_LEN + TAG_LEN; // 132
const TXT_METADATA_LEGACY_THRESHOLD = 200;
const USERNAME_LOOKUP_KEY_MIN_LEN = 32;
const USER_ROOT_KEY_MIN_LEN = 256;

const ORPHAN_PREVIEW_LIMIT = 50;
const S3_DELETE_BATCH_SIZE = 1000; // AWS DeleteObjects hard limit
const RETRY_DELAYS_MS = [2000, 4000, 8000]; // matches txt/r2.py's _RETRY_DELAYS

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface R2ConfigResolved {
  endpoint: string;
  region: string;
  bucket: string;
  readOnlyAccessKeyId: string;
  readOnlySecretAccessKey: string;
  readWriteAccessKeyId: string | null;
  readWriteSecretAccessKey: string | null;
}

interface Creds {
  username: string;
  usernameLookupKey: Buffer;
  userRootKey: Buffer;
  r2Config: R2ConfigResolved;
}

interface CryptoModule {
  hkdfSha3512(ikm: Uint8Array, salt: Uint8Array, outLen: number): Buffer;
  aeadDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
  ): Buffer;
}

interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface ObjectInfo {
  key: string;
  size: number;
}

interface RunStats {
  dryRun: boolean;
  txtCount: number;
  totalKnownPaths: number;
  totalObjects: number;
  orphanCount: number;
  orphanBytes: number;
  deletedCount: number;
  deletedBytes: number;
  deleteErrors: { key: string; message: string }[];
  elapsedMs: number;
}

class BlobDecryptError extends Error {}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function makeLogger(verbose: boolean): Logger {
  function line(level: string, msg: string, out: (s: string) => void) {
    out(`${new Date().toISOString()} ${level.padEnd(6)} ${msg}`);
  }
  return {
    debug: (msg) => {
      if (verbose) line("DEBUG", msg, (s) => console.log(s));
    },
    info: (msg) => line("INFO", msg, (s) => console.log(s)),
    warn: (msg) => line("WARN", msg, (s) => console.log(s)),
    error: (msg) => line("ERROR", msg, (s) => console.error(s)),
  };
}

// ---------------------------------------------------------------------------
// Crypto: WASM Ascon-Keccak AEAD + HKDF-SHA3-512, native HMAC-SHA3-256
// ---------------------------------------------------------------------------

async function initCrypto(): Promise<CryptoModule> {
  const Module = await Sqlite3Wasm();

  const keySz = Module._lc_wasm_key_size();
  const nonceSz = Module._lc_wasm_nonce_size();
  const tagSz = Module._lc_wasm_tag_size();
  if (keySz !== KEY_LEN || nonceSz !== IV_LEN || tagSz !== TAG_LEN) {
    throw new Error(
      `unexpected leancrypto wasm sizes: key=${keySz} nonce=${nonceSz} tag=${tagSz} (expected ${KEY_LEN}/${IV_LEN}/${TAG_LEN})`,
    );
  }

  function toWasm(buf: Uint8Array): number {
    const ptr = Module._malloc(buf.length || 1);
    Module.HEAPU8.set(buf, ptr);
    return ptr;
  }
  function fromWasm(ptr: number, len: number): Buffer {
    return Buffer.from(Module.HEAPU8.subarray(ptr, ptr + len));
  }

  function hkdfSha3512(ikm: Uint8Array, salt: Uint8Array, outLen: number): Buffer {
    const ikmPtr = toWasm(ikm);
    const saltPtr = toWasm(salt);
    const outPtr = Module._malloc(outLen);
    try {
      const rc = Module._lc_wasm_hkdf_sha3_512(
        ikmPtr,
        ikm.length,
        saltPtr,
        salt.length,
        0,
        0,
        outPtr,
        outLen,
      );
      if (rc !== 0) throw new Error(`lc_wasm_hkdf_sha3_512 failed, rc=${rc}`);
      return fromWasm(outPtr, outLen);
    } finally {
      Module._free(ikmPtr);
      Module._free(saltPtr);
      Module._free(outPtr);
    }
  }

  function aeadDecrypt(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    ciphertext: Uint8Array,
    tag: Uint8Array,
  ): Buffer {
    const keyPtr = toWasm(key);
    const ivPtr = toWasm(iv);
    const aadPtr = toWasm(aad);
    const ctPtr = toWasm(ciphertext);
    const tagPtr = toWasm(tag);
    const ptPtr = Module._malloc(ciphertext.length || 1);
    try {
      const rc = Module._lc_wasm_aead_decrypt(
        keyPtr,
        key.length,
        ivPtr,
        iv.length,
        aadPtr,
        aad.length,
        ctPtr,
        ciphertext.length,
        ptPtr,
        tagPtr,
        tag.length,
      );
      if (rc !== 0) {
        throw new BlobDecryptError("AEAD tag verification failed");
      }
      return fromWasm(ptPtr, ciphertext.length);
    } finally {
      Module._free(keyPtr);
      Module._free(ivPtr);
      Module._free(aadPtr);
      Module._free(ctPtr);
      Module._free(tagPtr);
      Module._free(ptPtr);
    }
  }

  return { hkdfSha3512, aeadDecrypt };
}

function usernameHash(usernameLookupKey: Buffer, username: string): Buffer {
  return createHmac("sha3-256", usernameLookupKey).update(username, "utf8").digest();
}

// Port of docs/crypto.md's Decrypt algorithm / txt/crypto.py's Blob.decrypt
// (no `compressed` support needed -- this tool only ever decrypts raw ascii
// raw_path strings, never brotli-compressed JSON).
function blobDecrypt(cm: CryptoModule, ikm: Uint8Array, blob: Uint8Array): Buffer {
  if (blob.length < BLOB_MIN_LEN) {
    throw new Error(`blob shorter than minimum valid length (${blob.length} < ${BLOB_MIN_LEN})`);
  }
  if (blob[0] !== MAGIC[0] || blob[1] !== MAGIC[1]) {
    throw new Error("bad blob magic");
  }
  if (blob[2] !== VERSION_MAJOR) {
    throw new Error(`unsupported blob major version: ${blob[2]}`);
  }
  const ad = blob.subarray(0, AD_LEN);
  const salt = blob.subarray(HEADER_LEN, AD_LEN);
  const ciphertext = blob.subarray(AD_LEN, blob.length - TAG_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);

  const okm = cm.hkdfSha3512(ikm, salt, OKM_LEN);
  const key = okm.subarray(0, KEY_LEN);
  const iv = okm.subarray(KEY_LEN, OKM_LEN);
  return cm.aeadDecrypt(key, iv, ad, ciphertext, tag);
}

// ---------------------------------------------------------------------------
// Creds loading
// ---------------------------------------------------------------------------

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`creds.json missing/empty field: ${field}`);
  }
  return value;
}

function loadCreds(path: string, dryRun: boolean): Creds {
  const raw = JSON.parse(readFileSync(path, "utf8"));

  const username = requireNonEmptyString(raw.username, "username");
  const usernameLookupKey = Buffer.from(
    requireNonEmptyString(raw.username_lookup_key, "username_lookup_key"),
    "base64",
  );
  if (usernameLookupKey.length < USERNAME_LOOKUP_KEY_MIN_LEN) {
    throw new Error(
      `username_lookup_key too short (${usernameLookupKey.length} < ${USERNAME_LOOKUP_KEY_MIN_LEN} bytes)`,
    );
  }
  const userRootKey = Buffer.from(
    requireNonEmptyString(raw.user_root_key, "user_root_key"),
    "base64",
  );
  if (userRootKey.length < USER_ROOT_KEY_MIN_LEN) {
    throw new Error(
      `user_root_key too short (${userRootKey.length} < ${USER_ROOT_KEY_MIN_LEN} bytes)`,
    );
  }
  // password is part of the shared creds shape but unused here: this tool
  // goes straight from user_root_key to umk, no login/auth step.

  const r2raw = raw.r2_config ?? {};
  const r2Config: R2ConfigResolved = {
    endpoint: requireNonEmptyString(r2raw.endpoint, "r2_config.endpoint"),
    region: requireNonEmptyString(r2raw.region, "r2_config.region"),
    bucket: requireNonEmptyString(r2raw.bucket, "r2_config.bucket"),
    readOnlyAccessKeyId: requireNonEmptyString(
      r2raw.read_only_access_key_id,
      "r2_config.read_only_access_key_id",
    ),
    readOnlySecretAccessKey: requireNonEmptyString(
      r2raw.read_only_secret_access_key,
      "r2_config.read_only_secret_access_key",
    ),
    readWriteAccessKeyId: r2raw.read_write_access_key_id || null,
    readWriteSecretAccessKey: r2raw.read_write_secret_access_key || null,
  };
  // Deletion needs read-write keys; --dry-run only lists, so read-only-only
  // creds are tolerated there (deliberate deviation from the Python
  // reference, confirmed with the user).
  if (!dryRun && !(r2Config.readWriteAccessKeyId && r2Config.readWriteSecretAccessKey)) {
    throw new Error(
      "r2_config must include read_write_access_key_id/read_write_secret_access_key " +
        "for a live (non---dry-run) run",
    );
  }

  return { username, usernameLookupKey, userRootKey, r2Config };
}

// ---------------------------------------------------------------------------
// DB / owner resolution (read-only port of txt/owner.py's TxtOwner)
// ---------------------------------------------------------------------------

function openDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function resolveOwnerUserId(db: DatabaseSync, creds: Creds, log: Logger): number {
  const hash = usernameHash(creds.usernameLookupKey, creds.username);
  const row = db.prepare("SELECT id FROM users WHERE username_hash = ?").get(hash) as
    | { id: number }
    | undefined;
  if (!row) {
    throw new Error(`no user found for username=${JSON.stringify(creds.username)}`);
  }
  log.debug(`Resolved owner user_id=${row.id} for username=${JSON.stringify(creds.username)}`);
  return row.id;
}

function resolveOwnerUmk(
  db: DatabaseSync,
  cm: CryptoModule,
  creds: Creds,
  userId: number,
  log: Logger,
): Buffer {
  const row = db.prepare("SELECT umk FROM umk_store WHERE user_id = ?").get(userId) as
    | { umk: Uint8Array }
    | undefined;
  if (!row) {
    throw new Error(`no umk_store row for user_id=${userId}`);
  }
  const umk = blobDecrypt(cm, creds.userRootKey, row.umk);
  log.debug(`Unwrapped umk for user_id=${userId}`);
  return umk;
}

function listTxtIds(db: DatabaseSync, userId: number): number[] {
  const rows = db.prepare("SELECT id FROM txt WHERE user_id = ?").all(userId) as {
    id: number;
  }[];
  return rows.map((r) => r.id);
}

function resolveTxtKey(db: DatabaseSync, cm: CryptoModule, txtId: number, umk: Buffer): Buffer {
  const row = db.prepare("SELECT txt_key FROM txt WHERE id = ?").get(txtId) as
    | { txt_key: Uint8Array }
    | undefined;
  if (!row) {
    throw new Error(`no txt row for txt_id=${txtId}`);
  }
  return blobDecrypt(cm, umk, row.txt_key);
}

function listPartRawPaths(
  db: DatabaseSync,
  cm: CryptoModule,
  txtId: number,
  txtKey: Buffer,
): string[] {
  const rows = db
    .prepare("SELECT path FROM txt_parts WHERE txt_id = ? ORDER BY part_num ASC")
    .all(txtId) as { path: Uint8Array }[];
  return rows.map((r) => blobDecrypt(cm, txtKey, r.path).toString("ascii"));
}

// Returns null when there's no R2 object to keep for this account's
// txt_metadata: no row at all, content still NULL, or content is still the
// pre-R2-indirection legacy inline-JSON format (>= TXT_METADATA_LEGACY_THRESHOLD
// bytes -- see docs/data_model.md).
function resolveTxtMetadataRawPath(
  db: DatabaseSync,
  cm: CryptoModule,
  userId: number,
  umk: Buffer,
): string | null {
  const row = db
    .prepare("SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?")
    .get(userId) as { txt_metadata_key: Uint8Array; content: Uint8Array | null } | undefined;
  if (!row || row.content === null) {
    return null;
  }
  if (row.content.length >= TXT_METADATA_LEGACY_THRESHOLD) {
    return null;
  }
  const txtMetadataKey = blobDecrypt(cm, umk, row.txt_metadata_key);
  return blobDecrypt(cm, txtMetadataKey, row.content).toString("ascii");
}

function collectKnownRawPaths(
  db: DatabaseSync,
  cm: CryptoModule,
  userId: number,
  umk: Buffer,
  log: Logger,
): { known: Set<string>; txtCount: number } {
  const txtIds = listTxtIds(db, userId);
  const known = new Set<string>();
  txtIds.forEach((txtId, i) => {
    const txtKey = resolveTxtKey(db, cm, txtId, umk);
    const paths = listPartRawPaths(db, cm, txtId, txtKey);
    paths.forEach((p) => known.add(p));
    log.debug(
      `txt_id=${txtId} (${i + 1}/${txtIds.length}): ${paths.length} known part path(s)`,
    );
  });
  const metadataPath = resolveTxtMetadataRawPath(db, cm, userId, umk);
  if (metadataPath !== null) {
    known.add(metadataPath);
    log.debug(`txt_metadata's current R2 object: ${metadataPath}`);
  }
  return { known, txtCount: txtIds.length };
}

// ---------------------------------------------------------------------------
// R2 client
// ---------------------------------------------------------------------------

function createS3Client(r2: R2ConfigResolved, dryRun: boolean): S3Client {
  const accessKeyId = dryRun && !r2.readWriteAccessKeyId ? r2.readOnlyAccessKeyId : r2.readWriteAccessKeyId!;
  const secretAccessKey =
    dryRun && !r2.readWriteSecretAccessKey ? r2.readOnlySecretAccessKey : r2.readWriteSecretAccessKey!;
  return new S3Client({
    endpoint: r2.endpoint,
    region: r2.region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(log: Logger, what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  const maxAttempts = 1 + RETRY_DELAYS_MS.length;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      log.warn(`${what} failed (attempt ${attempt}/${maxAttempts}): ${lastErr} -- retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  log.error(`${what} failed after ${maxAttempts} attempt(s), giving up`);
  throw lastErr;
}

async function listAllObjects(s3: S3Client, bucket: string, log: Logger): Promise<ObjectInfo[]> {
  const objects: ObjectInfo[] = [];
  let token: string | undefined;
  let page = 0;
  do {
    const resp = await withRetries(log, "list bucket page", () =>
      s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token })),
    );
    for (const o of resp.Contents ?? []) {
      if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0 });
    }
    page++;
    log.debug(`Listed page ${page}: ${resp.Contents?.length ?? 0} object(s), ${objects.length} total so far`);
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  log.info(`Found ${objects.length} object(s) in the R2 bucket`);
  return objects;
}

async function deleteObjectsBatch(
  s3: S3Client,
  bucket: string,
  keys: string[],
  log: Logger,
): Promise<{ deletedKeys: Set<string>; errors: { key: string; message: string }[] }> {
  const deletedKeys = new Set<string>();
  const errors: { key: string; message: string }[] = [];
  for (let i = 0; i < keys.length; i += S3_DELETE_BATCH_SIZE) {
    const chunk = keys.slice(i, i + S3_DELETE_BATCH_SIZE);
    const resp = await withRetries(log, `delete batch [${i}..${i + chunk.length})`, () =>
      s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map((k) => ({ Key: k })), Quiet: false },
        }),
      ),
    );
    for (const d of resp.Deleted ?? []) {
      if (d.Key) deletedKeys.add(d.Key);
    }
    for (const e of resp.Errors ?? []) {
      if (e.Key) errors.push({ key: e.Key, message: `${e.Code}: ${e.Message}` });
    }
    log.debug(`Deleted batch: ${resp.Deleted?.length ?? 0} ok, ${resp.Errors?.length ?? 0} error(s)`);
  }
  return { deletedKeys, errors };
}

// ---------------------------------------------------------------------------
// Orphan computation + stats
// ---------------------------------------------------------------------------

function computeOrphans(objects: ObjectInfo[], known: Set<string>): ObjectInfo[] {
  return objects.filter((o) => !known.has(o.key));
}

function formatBytes(n: number): string {
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

function printOrphanPreview(orphans: ObjectInfo[], log: Logger): void {
  const preview = orphans.slice(0, ORPHAN_PREVIEW_LIMIT);
  for (const o of preview) {
    log.info(`  ${o.key}  (${formatBytes(o.size)})`);
  }
  if (orphans.length > ORPHAN_PREVIEW_LIMIT) {
    log.info(`  ...and ${orphans.length - ORPHAN_PREVIEW_LIMIT} more`);
  }
}

function printStats(stats: RunStats, log: Logger): void {
  log.info("--- clean-bucket summary ---");
  log.info(`mode:               ${stats.dryRun ? "DRY RUN (no objects deleted)" : "LIVE"}`);
  log.info(`txt documents:      ${stats.txtCount}`);
  log.info(`known paths (kept): ${stats.totalKnownPaths}`);
  log.info(`objects in bucket:  ${stats.totalObjects}`);
  log.info(`orphaned objects:   ${stats.orphanCount} (${formatBytes(stats.orphanBytes)})`);
  log.info(`deleted objects:    ${stats.deletedCount} (${formatBytes(stats.deletedBytes)})`);
  if (stats.deleteErrors.length > 0) {
    log.error(`delete errors:      ${stats.deleteErrors.length} (see above)`);
  }
  log.info(`elapsed:            ${(stats.elapsedMs / 1000).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error(
    "Usage: node txt.ts --clean-bucket <in.db> --creds <creds.json> [-v|--verbose] [--dry-run] [-y|--yes]",
  );
}

interface CliArgs {
  inDb: string;
  credsPath: string;
  verbose: boolean;
  dryRun: boolean;
  yes: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "clean-bucket": { type: "string" },
      creds: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
  });
  if (!values["clean-bucket"] || !values.creds) {
    printUsage();
    process.exit(1);
  }
  return {
    inDb: values["clean-bucket"] as string,
    credsPath: values.creds as string,
    verbose: values.verbose as boolean,
    dryRun: values["dry-run"] as boolean,
    yes: values.yes as boolean,
  };
}

async function confirmDestructive(message: string, skip: boolean, log: Logger): Promise<void> {
  if (skip) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question(`${message} [y/N] `);
  } finally {
    rl.close();
  }
  if (answer.trim().toLowerCase() !== "y") {
    log.info("Aborted.");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseCliArgs(process.argv.slice(2));
  const log = makeLogger(args.verbose);

  let db: DatabaseSync | undefined;
  try {
    const creds = loadCreds(args.credsPath, args.dryRun);
    const cm = await initCrypto();
    db = openDb(args.inDb);

    const userId = resolveOwnerUserId(db, creds, log);
    const umk = resolveOwnerUmk(db, cm, creds, userId, log);
    const { known, txtCount } = collectKnownRawPaths(db, cm, userId, umk, log);
    log.info(`Found ${known.size} known path(s) in DB for user_id=${userId}`);

    const s3 = createS3Client(creds.r2Config, args.dryRun);
    const objects = await listAllObjects(s3, creds.r2Config.bucket, log);
    const orphans = computeOrphans(objects, known);
    const orphanBytes = orphans.reduce((sum, o) => sum + o.size, 0);
    log.info(`Found ${orphans.length} orphaned object(s) not present in DB (${formatBytes(orphanBytes)})`);

    let deletedCount = 0;
    let deletedBytes = 0;
    let deleteErrors: { key: string; message: string }[] = [];

    if (!args.dryRun && orphans.length > 0) {
      await confirmDestructive(
        `Delete ${orphans.length} orphaned object(s) (${formatBytes(orphanBytes)}) from bucket=${creds.r2Config.bucket} for username=${creds.username}? This cannot be undone.`,
        args.yes,
        log,
      );
      const { deletedKeys, errors } = await deleteObjectsBatch(
        s3,
        creds.r2Config.bucket,
        orphans.map((o) => o.key),
        log,
      );
      deletedCount = deletedKeys.size;
      deletedBytes = orphans.filter((o) => deletedKeys.has(o.key)).reduce((s, o) => s + o.size, 0);
      deleteErrors = errors;
      log.info(`Deleted ${deletedCount} orphaned object(s) from the R2 bucket`);
    }

    printOrphanPreview(orphans, log);
    printStats(
      {
        dryRun: args.dryRun,
        txtCount,
        totalKnownPaths: known.size,
        totalObjects: objects.length,
        orphanCount: orphans.length,
        orphanBytes,
        deletedCount,
        deletedBytes,
        deleteErrors,
        elapsedMs: Date.now() - startedAt,
      },
      log,
    );

    process.exitCode = deleteErrors.length > 0 ? 1 : 0;
  } catch (e) {
    log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

main();
