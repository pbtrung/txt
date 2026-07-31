// Runs as a real Worker -- this is where SqliteDb/registerRemoteVfs actually
// live now, not the main thread. A real browser forbids Atomics.wait()
// outside a Worker (confirmed against genuine Chromium: it throws
// "Atomics.wait cannot be called in this context" when called from the
// main/document thread), but remoteVfs.ts's xRead needs exactly that to
// bridge SQLite's synchronous WASM callback to remotePageClient.ts's async
// READ_PAGE fetch -- so the whole SQLite/VFS/commit layer has to live in a
// Worker, with the main thread (state/VaultContext.tsx, screens/Reader/
// useReaderBook.ts) talking to it via the small RPC protocol below instead
// of holding a SqliteDb directly. remotePageWorker.ts (the actual page-fetch
// worker) is then a *nested* Worker spawned from here, same
// startRemotePageWorker() call remotePageClient.ts already provides --
// nesting workers is a normal, supported browser capability, so nothing
// there needed to change.
//
// Every write (recordReadPosition/removeAccessEntry/addBookmarkEntry/
// removeBookmarkEntry) is serialized through requestQueue below: each
// handler's own `await commitOrThrow(...)` yields back to this worker's
// event loop, so two RPC calls in flight at once could otherwise interleave
// against the shared vfs dirty-page/commit state the same way two
// unserialized main-thread calls used to (see the state this replaced in
// VaultContext.tsx's git history) -- queuing every call through one promise
// chain keeps each write+commit atomic relative to the next.

import { verbose } from "../log";
import * as access from "./access";
import * as bookmarks from "./bookmarks";
import { loadLibrary } from "./library";
import * as owner from "./owner";
import { parseR2Config, type R2Config } from "./r2Config";
import {
  decodeBlobColumn,
  RqliteHttpClient,
  resolveTargetDbId,
  resultRows,
} from "./rqliteHttpClient";
import { registerRemoteVfs, MAX_CACHED_PAGES, type RemoteVfsHandle } from "./remoteVfs";
import { startRemotePageWorker, type RemotePageBridge } from "./remotePageClient";
import { SqliteDb } from "./sqliteDb";
import { loadWasm } from "./wasmLoader";

export interface OpenCreds {
  rqliteUrl: string;
  apiKey: string;
  userRootKey: Uint8Array;
}

interface Meta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
}

let db: SqliteDb | null = null;
let vfs: RemoteVfsHandle | null = null;
let rqliteClient: RqliteHttpClient | null = null;
let pageWorker: RemotePageBridge | null = null;
let storedCreds: OpenCreds | null = null;

function requireOpen(): { db: SqliteDb; vfs: RemoteVfsHandle; rqliteClient: RqliteHttpClient } {
  if (!db || !vfs || !rqliteClient) throw new Error("vault is locked");
  return { db, vfs, rqliteClient };
}

async function fetchMeta(client: RqliteHttpClient, targetDbId?: string): Promise<Meta> {
  const extra = targetDbId !== undefined ? { target_db_id: targetDbId } : {};
  const row = resultRows(await client.query("GET_META", [{}], extra))[0];
  if (!row) throw new Error("this account hasn't committed a database yet");
  return { currentVersion: Number(row[0]), pageCount: Number(row[1]), pageSize: Number(row[2]) };
}

// Target round trip count for prefetchPages below -- not a fixed page
// count per request, so a bigger MAX_CACHED_PAGES cap doesn't silently
// turn back into dozens of round trips. A large batch (~800 page_no's, one
// request) previously got HTTP 400 from auth_perms.lua once MAX_CACHED_PAGES
// grew to 4000, which briefly got worked around by capping the per-request
// batch size -- but the real cause was docker/nginx.conf's
// client_body_buffer_size never being set, spilling any body past its tiny
// (8k/16k) default to a temp file that ngx.req.get_body_data() can't read
// (see nginx.conf's own comment). Fixed there instead, so batch size is
// unbounded again here.
const PREFETCH_ROUND_TRIPS = 5;

/** Eagerly fetches this account's pages in a handful of batched round trips
 * right after open() learns the page count, instead of leaving every one
 * of them to be discovered and fetched individually later by SQLite's own
 * page-at-a-time xRead callback -- that's what made the initial "Loading
 * your books..." unlock phase slow (loadLibrary()/loadBookmarksMap()
 * touch a lot of small, scattered pages on a first open, each one its own
 * round trip through remotePageClient.ts's Atomics bridge). Capped at
 * MAX_CACHED_PAGES: prefetching more than the cache can hold would just
 * evict some of them before SQLite ever reads them. Returns pages keyed
 * by page number, fed into vfs.primeCache() by the caller. */
async function prefetchPages(
  client: RqliteHttpClient,
  pageCount: number,
  snapshot: number,
  targetDbId: string | undefined,
): Promise<Map<number, Uint8Array>> {
  const total = Math.min(pageCount, MAX_CACHED_PAGES);
  const batchSize = Math.max(1, Math.ceil(total / PREFETCH_ROUND_TRIPS));
  const extra = targetDbId !== undefined ? { target_db_id: targetDbId } : {};
  const pages = new Map<number, Uint8Array>();
  const start = performance.now();
  let roundTrips = 0;
  for (let from = 1; from <= total; from += batchSize) {
    const to = Math.min(from + batchSize - 1, total);
    const batch = [];
    for (let pageNo = from; pageNo <= to; pageNo++) batch.push({ page_no: pageNo, snapshot });
    const results = await client.query("READ_PAGE", batch, extra);
    for (let i = 0; i < batch.length; i++) {
      const row = resultRows(results, i)[0];
      if (row) pages.set(from + i, decodeBlobColumn(row[0]));
    }
    roundTrips++;
    verbose(`dbWorker: prefetched pages ${from}-${to} of ${total}`);
  }
  verbose(
    `dbWorker: prefetch done -- ${pages.size} page(s) in ${roundTrips} round trip(s), ` +
      `${(performance.now() - start).toFixed(1)}ms`,
  );
  return pages;
}

/** Opens (or re-opens, for refresh) this account's SQLCipher db against a
 * fresh lazy VFS -- always a brand new nested worker/VFS registration/
 * backed-path, never reused, since sqlite3_vfs_register has no "replace"
 * semantics (see state/VaultContext.tsx's git history for the original
 * version of this same reasoning, from when it lived there instead). */
export async function open(creds: OpenCreds): Promise<void> {
  await close();
  storedCreds = creds;
  rqliteClient = new RqliteHttpClient(creds.rqliteUrl, creds.apiKey);
  // This app's own account is itself role='admin' (the sole account
  // --migrate creates -- see docs/data_model.md), which has no implicit
  // "self" tenant and needs target_db_id named explicitly on every
  // statement (docker/auth_perms.lua). undefined for a genuine user-role
  // key, which the server forces to its own db_id regardless.
  const targetDbId = await resolveTargetDbId(rqliteClient, creds.apiKey);
  const meta = await fetchMeta(rqliteClient, targetDbId);
  pageWorker = await startRemotePageWorker(
    creds.rqliteUrl,
    creds.apiKey,
    meta.pageSize,
    meta.currentVersion,
    targetDbId,
  );
  const sessionId = crypto.randomUUID();
  const backedPath = `/vault-${sessionId}.db`;
  const mod = await loadWasm();
  vfs = registerRemoteVfs(mod, {
    name: `remotevfs-${sessionId}`,
    pageSize: meta.pageSize,
    pageCount: meta.pageCount,
    currentVersion: meta.currentVersion,
    backedPath,
    fetchPage: pageWorker.fetchPage,
    targetDbId,
  });
  const prefetched = await prefetchPages(
    rqliteClient,
    meta.pageCount,
    meta.currentVersion,
    targetDbId,
  );
  vfs.primeCache(prefetched);
  db = await SqliteDb.open(backedPath, { vfsName: vfs.name, rawKey: creds.userRootKey });
}

export async function refresh(): Promise<void> {
  if (!storedCreds) throw new Error("vault is locked");
  await open(storedCreds);
}

export async function close(): Promise<void> {
  pageWorker?.terminate();
  db?.close();
  db = null;
  vfs = null;
  rqliteClient = null;
  pageWorker = null;
}

/** Flushes dirty pages via one atomic COMMIT. Throws if another writer's
 * commit won the CAS race first -- see remoteVfs.ts's own doc comment on
 * RemoteVfsHandle.commit for why this isn't silently retried. */
export async function commitOrThrow(): Promise<void> {
  const { vfs, rqliteClient } = requireOpen();
  const ok = await vfs.commit(rqliteClient);
  if (!ok) {
    throw new Error("Another session updated this vault. Please reload and try again.");
  }
}

export function fetchTxtKey(txtId: number): Uint8Array {
  const { db } = requireOpen();
  const stmt = db.prepare("SELECT txt_key FROM txt WHERE id = ?;");
  stmt.bindInt64(1, txtId);
  const found = stmt.step();
  const key = found ? stmt.columnBlob(0) : null;
  stmt.finalize();
  if (!key) throw new Error(`no txt row for txt_id=${txtId}`);
  return key;
}

/** Reads r2_config's single row (docs/data_model.md) straight off this
 * account's own SQLCipher db -- not from the unlock creds file, see
 * creds.ts's own comment. read_write_access_key_id/secret are NULL for
 * every db except the admin's own, hence columnIsNull rather than
 * columnText for those two. */
export function fetchR2Config(): R2Config {
  const { db } = requireOpen();
  const stmt = db.prepare(
    `SELECT endpoint, region, bucket, read_only_access_key_id, read_only_secret_access_key,
            read_write_access_key_id, read_write_secret_access_key
     FROM r2_config WHERE id = 1;`,
  );
  const found = stmt.step();
  if (!found) {
    stmt.finalize();
    throw new Error("no r2_config row for this account");
  }
  const raw = {
    endpoint: stmt.columnText(0),
    region: stmt.columnText(1),
    bucket: stmt.columnText(2),
    read_only_access_key_id: stmt.columnText(3),
    read_only_secret_access_key: stmt.columnText(4),
    read_write_access_key_id: stmt.columnIsNull(5) ? undefined : stmt.columnText(5),
    read_write_secret_access_key: stmt.columnIsNull(6) ? undefined : stmt.columnText(6),
  };
  stmt.finalize();
  return parseR2Config(raw);
}

export async function loadLibraryHandler() {
  const { db } = requireOpen();
  return loadLibrary(db);
}

export function loadBookmarksMapHandler() {
  const { db } = requireOpen();
  return bookmarks.loadBookmarksMap(db);
}

export async function recordReadPosition(
  txtId: number,
  position: access.ReadPosition,
): Promise<void> {
  const { db } = requireOpen();
  access.setReadPosition(db, txtId, position.lastPartNum, position.lastAccessedMs);
  await commitOrThrow();
}

export async function removeAccessEntry(txtId: number): Promise<void> {
  const { db } = requireOpen();
  access.clearReadPosition(db, txtId);
  await commitOrThrow();
}

export async function addBookmarkEntry(
  txtId: number,
  partNum: number,
  line: number,
  preview: string,
  createdAt: number,
) {
  const { db } = requireOpen();
  bookmarks.addBookmark(db, txtId, partNum, line, preview, createdAt);
  await commitOrThrow();
  return bookmarks.loadBookmarksMap(db);
}

export async function removeBookmarkEntry(bookmarkId: number) {
  const { db } = requireOpen();
  bookmarks.removeBookmark(db, bookmarkId);
  await commitOrThrow();
  return bookmarks.loadBookmarksMap(db);
}

export function partCount(txtId: number): number {
  const { db } = requireOpen();
  return owner.partCount(db, txtId);
}

export function partRawPath(txtId: number, partNum: number): string | null {
  const { db } = requireOpen();
  return owner.partRawPath(db, txtId, partNum);
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  open,
  close,
  refresh,
  getTxtKey: fetchTxtKey,
  getR2Config: fetchR2Config,
  loadLibrary: loadLibraryHandler,
  loadBookmarksMap: loadBookmarksMapHandler,
  recordReadPosition,
  removeAccessEntry,
  addBookmarkEntry,
  removeBookmarkEntry,
  partCount,
  partRawPath,
};

interface RpcRequest {
  type: "call";
  id: number;
  method: string;
  args: unknown[];
}

// Serializes every RPC call through one promise chain -- see this file's
// header comment for why (write handlers' own internal awaits would
// otherwise let a second queued call start before the first's commit
// settles).
let queue: Promise<unknown> = Promise.resolve();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Guarded: this module is also imported directly by dbWorker.test.ts (to
// exercise open/recordReadPosition/etc. against a real SqliteDb without a
// real Worker environment, which Node/jsdom don't provide) -- `self` only
// exists in an actual Worker, so wiring this unconditionally would throw
// the moment a test imports the module at all.
if (typeof self !== "undefined") {
  self.onmessage = (ev: MessageEvent<RpcRequest>) => {
    const { id, method, args } = ev.data;
    const handler = handlers[method];
    const run = async () => {
      if (!handler) throw new Error(`dbWorker: unknown method ${method}`);
      return handler(...args);
    };
    queue = queue.then(run, run).then(
      (result) => self.postMessage({ type: "result", id, ok: true, result }),
      (err: unknown) =>
        self.postMessage({ type: "result", id, ok: false, error: errorMessage(err) }),
    );
  };
}
