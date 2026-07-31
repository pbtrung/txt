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

import * as access from "./access";
import * as bookmarks from "./bookmarks";
import { loadLibrary } from "./library";
import * as owner from "./owner";
import { RqliteHttpClient, resolveTargetDbId, resultRows } from "./rqliteHttpClient";
import { registerRemoteVfs, type RemoteVfsHandle } from "./remoteVfs";
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
