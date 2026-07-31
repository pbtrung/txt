// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
//
// Unlike the old Turso-backed session, "unlocked" here means a real
// SQLCipher database is open against a lazy remote VFS (remoteVfs.ts):
// pages are fetched from rqlite on demand, through a worker+Atomics bridge
// (remotePageClient.ts), and writes stay in memory until explicitly
// committed back (see commitOrThrow below). No umk/priv_key/isAdmin -- the
// api_key that opens the page store is the only credential there is, and
// there is no sharing system in this schema at all.

import type { AwsClient } from "aws4fetch";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import * as access from "../data/access";
import type { AccessMap, ReadPosition } from "../data/access";
import * as bookmarks from "../data/bookmarks";
import type { BookmarksMap } from "../data/bookmarks";
import { loadCredsFromFile, type Creds } from "../data/creds";
import { loadLibrary } from "../data/library";
import type { BookInfo } from "../data/metadata";
import { createR2Client } from "../data/r2";
import { resultRows, RqliteHttpClient } from "../data/rqliteHttpClient";
import { registerRemoteVfs, type RemoteVfsHandle } from "../data/remoteVfs";
import { startRemotePageWorker, type RemotePageBridge } from "../data/remotePageClient";
import { SqliteDb } from "../data/sqliteDb";
import { loadWasm } from "../data/wasmLoader";
import { verbose } from "../log";

export type VaultStatus = "locked" | "unlocking" | "unlocked";

/** The current phase of an in-progress unlock()/refresh() call, for the two
 * dynamically-updating lines shown under the Unlock/Library refresh
 * spinners -- label is the phase itself, step/total a "Step N of M"
 * counter. null whenever neither is running. */
export interface VaultProgress {
  label: string;
  step: number;
  total: number;
}

const UNLOCK_PHASES = [
  "Connecting to your vault",
  "Opening your database",
  "Loading your books",
] as const;
const REFRESH_PHASES = ["Loading your books", "Loading your bookmarks"] as const;

function phaseProgress(phases: readonly string[], index: number): VaultProgress {
  return { label: phases[index], step: index + 1, total: phases.length };
}

export interface VaultSession {
  creds: Creds;
  db: SqliteDb;
  vfs: RemoteVfsHandle;
  rqliteClient: RqliteHttpClient;
  pageWorker: RemotePageBridge;
  r2Client: AwsClient;
  metadataById: Map<number, BookInfo>;
}

export interface VaultContextValue {
  status: VaultStatus;
  session: VaultSession | null;
  error: string | null;
  accessMap: AccessMap;
  bookmarksMap: BookmarksMap;
  refreshing: boolean;
  progress: VaultProgress | null;
  unlock: (file: File) => Promise<void>;
  lock: () => void;
  refresh: () => Promise<void>;
  getTxtKey: (txtId: number) => Promise<Uint8Array>;
  recordReadPosition: (txtId: number, position: ReadPosition) => Promise<void>;
  removeAccessEntry: (txtId: number) => Promise<void>;
  addBookmarkEntry: (
    txtId: number,
    partNum: number,
    line: number,
    preview: string,
  ) => Promise<void>;
  removeBookmarkEntry: (bookmarkId: number) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface Meta {
  currentVersion: number;
  pageCount: number;
  pageSize: number;
}

async function fetchMeta(client: RqliteHttpClient): Promise<Meta> {
  const row = resultRows(await client.query("GET_META", [{}]))[0];
  if (!row) throw new Error("this account hasn't committed a database yet");
  return { currentVersion: Number(row[0]), pageCount: Number(row[1]), pageSize: Number(row[2]) };
}

interface OpenedVault {
  db: SqliteDb;
  vfs: RemoteVfsHandle;
  rqliteClient: RqliteHttpClient;
  pageWorker: RemotePageBridge;
  r2Client: AwsClient;
}

/** Opens (or re-opens, for refresh()) this account's SQLCipher db against a
 * fresh lazy VFS -- a brand new worker/VFS/backed-path per call, never
 * reused, since sqlite3_vfs_register has no "replace" semantics: a second
 * registration under a name already in use would just be shadowed, silently
 * keeping the *first* session's (by-then-closed) page callbacks alive. */
async function openVault(creds: Creds): Promise<OpenedVault> {
  const rqliteClient = new RqliteHttpClient(creds.rqliteUrl, creds.apiKey);
  const meta = await fetchMeta(rqliteClient);
  const pageWorker = await startRemotePageWorker(
    creds.rqliteUrl,
    creds.apiKey,
    meta.pageSize,
    meta.currentVersion,
  );
  const sessionId = crypto.randomUUID();
  const backedPath = `/vault-${sessionId}.db`;
  const mod = await loadWasm();
  const vfs = registerRemoteVfs(mod, {
    name: `remotevfs-${sessionId}`,
    pageSize: meta.pageSize,
    pageCount: meta.pageCount,
    currentVersion: meta.currentVersion,
    backedPath,
    fetchPage: pageWorker.fetchPage,
  });
  const db = await SqliteDb.open(backedPath, { vfsName: vfs.name, rawKey: creds.userRootKey });
  const r2Client = createR2Client(creds.r2Config);
  return { db, vfs, rqliteClient, pageWorker, r2Client };
}

/** Flushes dirty pages via one atomic COMMIT (see remoteVfs.ts). Throws if
 * another writer's commit won the CAS race first -- rare for a single-user
 * reading app (another tab/device writing at the same instant), but real,
 * and not automatically resolved here: the caller is told to reload rather
 * than risk silently merging conflicting writes at the page level. */
async function commitOrThrow(vfs: RemoteVfsHandle, client: RqliteHttpClient): Promise<void> {
  const ok = await vfs.commit(client);
  if (!ok) {
    throw new Error("Another session updated this vault. Please reload and try again.");
  }
}

function fetchTxtKey(db: SqliteDb, txtId: number): Uint8Array {
  const stmt = db.prepare("SELECT txt_key FROM txt WHERE id = ?;");
  stmt.bindInt64(1, txtId);
  const found = stmt.step();
  const key = found ? stmt.columnBlob(0) : null;
  stmt.finalize();
  if (!key) throw new Error(`no txt row for txt_id=${txtId}`);
  return key;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMap, setAccessMap] = useState<AccessMap>(new Map());
  const [bookmarksMap, setBookmarksMap] = useState<BookmarksMap>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  const txtKeyCache = useRef(new Map<number, Uint8Array>());

  // Serializes every write against the vfs's shared dirty-page state
  // (recordReadPosition/removeAccessEntry/addBookmarkEntry/
  // removeBookmarkEntry): commit() reads and clears that state, so two
  // writes racing ahead of their own `await commitOrThrow` would otherwise
  // both compute the same base version and double-commit (or spuriously
  // trip the "another session" error against each other, not a real
  // external writer). Queuing every mutation through one promise chain
  // means each write+commit fully lands before the next one starts.
  const mutationQueue = useRef(Promise.resolve());
  const enqueueMutation = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.current.then(run, run);
    mutationQueue.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    setProgress(phaseProgress(UNLOCK_PHASES, 0));
    let opened: OpenedVault | null = null;
    try {
      verbose("unlock: reading creds file", file.name);
      const creds = await loadCredsFromFile(file);

      setProgress(phaseProgress(UNLOCK_PHASES, 1));
      verbose("unlock: opening vault against the lazy remote VFS");
      opened = await openVault(creds);

      setProgress(phaseProgress(UNLOCK_PHASES, 2));
      verbose("unlock: loading library");
      const { metadataById, accessMap: initialAccessMap } = await loadLibrary(opened.db);
      const initialBookmarksMap = bookmarks.loadBookmarksMap(opened.db);

      txtKeyCache.current = new Map();
      setAccessMap(initialAccessMap);
      setBookmarksMap(initialBookmarksMap);
      setSession({ creds, ...opened, metadataById });
      setStatus("unlocked");
      setProgress(null);
      verbose("unlock: done");
    } catch (err) {
      verbose("unlock: failed", err);
      opened?.pageWorker.terminate();
      opened?.db.close();
      setSession(null);
      setStatus("locked");
      setError(errorMessage(err) || "Failed to unlock your library.");
      setProgress(null);
    }
  }, []);

  const lock = useCallback(() => {
    txtKeyCache.current = new Map();
    session?.pageWorker.terminate();
    session?.db.close();
    setSession(null);
    setAccessMap(new Map());
    setBookmarksMap(new Map());
    setStatus("locked");
    setError(null);
  }, [session]);

  // Fully re-opens the db against a fresh VFS/worker (rather than reusing
  // the existing connection) so a document ingested elsewhere since unlock
  // -- more pages, a higher page_count -- is actually visible: this
  // session's VFS pins the page_count/version it saw at open time, the same
  // way any snapshot-based reader does (docs/data_model.md).
  const refresh = useCallback(async () => {
    if (!session) throw new Error("vault is locked");
    setRefreshing(true);
    setProgress(phaseProgress(REFRESH_PHASES, 0));
    try {
      verbose("refresh: re-opening vault");
      const opened = await openVault(session.creds);
      verbose("refresh: loading library");
      const { metadataById, accessMap: nextAccessMap } = await loadLibrary(opened.db);
      setProgress(phaseProgress(REFRESH_PHASES, 1));
      const nextBookmarksMap = bookmarks.loadBookmarksMap(opened.db);

      session.pageWorker.terminate();
      session.db.close();
      txtKeyCache.current = new Map();
      setSession((prev) => (prev ? { ...prev, ...opened, metadataById } : prev));
      setAccessMap(nextAccessMap);
      setBookmarksMap(nextBookmarksMap);
      verbose("refresh: done");
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  }, [session]);

  const getTxtKey = useCallback(
    async (txtId: number): Promise<Uint8Array> => {
      const cached = txtKeyCache.current.get(txtId);
      if (cached) return cached;
      if (!session) throw new Error("vault is locked");
      const txtKey = fetchTxtKey(session.db, txtId);
      txtKeyCache.current.set(txtId, txtKey);
      return txtKey;
    },
    [session],
  );

  const recordReadPosition = useCallback(
    async (txtId: number, position: ReadPosition) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        access.setReadPosition(session.db, txtId, position.lastPartNum, position.lastAccessedMs);
        await commitOrThrow(session.vfs, session.rqliteClient);
        setAccessMap((prev) => new Map(prev).set(txtId, position));
      });
    },
    [session, enqueueMutation],
  );

  const removeAccessEntry = useCallback(
    async (txtId: number) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        access.clearReadPosition(session.db, txtId);
        await commitOrThrow(session.vfs, session.rqliteClient);
        setAccessMap((prev) => {
          const next = new Map(prev);
          next.delete(txtId);
          return next;
        });
      });
    },
    [session, enqueueMutation],
  );

  const addBookmarkEntry = useCallback(
    async (txtId: number, partNum: number, line: number, preview: string) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        bookmarks.addBookmark(session.db, txtId, partNum, line, preview, Date.now());
        await commitOrThrow(session.vfs, session.rqliteClient);
        setBookmarksMap(bookmarks.loadBookmarksMap(session.db));
      });
    },
    [session, enqueueMutation],
  );

  const removeBookmarkEntry = useCallback(
    async (bookmarkId: number) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        bookmarks.removeBookmark(session.db, bookmarkId);
        await commitOrThrow(session.vfs, session.rqliteClient);
        setBookmarksMap(bookmarks.loadBookmarksMap(session.db));
      });
    },
    [session, enqueueMutation],
  );

  const value = useMemo<VaultContextValue>(
    () => ({
      status,
      session,
      error,
      accessMap,
      bookmarksMap,
      refreshing,
      progress,
      unlock,
      lock,
      refresh,
      getTxtKey,
      recordReadPosition,
      removeAccessEntry,
      addBookmarkEntry,
      removeBookmarkEntry,
    }),
    [
      status,
      session,
      error,
      accessMap,
      bookmarksMap,
      refreshing,
      progress,
      unlock,
      lock,
      refresh,
      getTxtKey,
      recordReadPosition,
      removeAccessEntry,
      addBookmarkEntry,
      removeBookmarkEntry,
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error("useVault() must be used within a VaultProvider");
  }
  return ctx;
}
