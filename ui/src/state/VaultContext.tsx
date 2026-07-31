// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
//
// Unlike the old Turso-backed session, "unlocked" here means a real
// SQLCipher database is open against a lazy remote VFS -- but that db/VFS/
// commit state all lives inside a dedicated Worker (data/dbWorker.ts), not
// here: a real browser forbids Atomics.wait() outside a Worker, which
// remoteVfs.ts's xRead needs to bridge SQLite's synchronous WASM callback
// to a page fetch, so SQLite itself has to run there instead of on the main
// thread. This file only ever talks to that Worker through
// DbWorkerClient's small RPC surface. No umk/priv_key/isAdmin -- the
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

import type { AccessMap, ReadPosition } from "../data/access";
import type { BookmarksMap } from "../data/bookmarks";
import { loadCredsFromFile, type Creds } from "../data/creds";
import { DbWorkerClient } from "../data/dbWorkerClient";
import type { BookInfo } from "../data/metadata";
import { createR2Client } from "../data/r2";
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
  client: DbWorkerClient;
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

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMap, setAccessMap] = useState<AccessMap>(new Map());
  const [bookmarksMap, setBookmarksMap] = useState<BookmarksMap>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  // Every write serializes inside dbWorker.ts itself now (one single-
  // threaded queue in the worker realm), so unlike the pre-Worker version
  // of this file, nothing here needs its own mutation queue -- just a
  // main-thread cache to skip a getTxtKey RPC round trip for a txt_id
  // already looked up this session.
  const txtKeyCache = useRef(new Map<number, Uint8Array>());

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    setProgress(phaseProgress(UNLOCK_PHASES, 0));
    let client: DbWorkerClient | null = null;
    try {
      verbose("unlock: reading creds file", file.name);
      const creds = await loadCredsFromFile(file);

      setProgress(phaseProgress(UNLOCK_PHASES, 1));
      verbose("unlock: opening vault against the lazy remote VFS (in a worker)");
      client = new DbWorkerClient();
      await client.open({
        rqliteUrl: creds.rqliteUrl,
        apiKey: creds.apiKey,
        userRootKey: creds.userRootKey,
      });

      setProgress(phaseProgress(UNLOCK_PHASES, 2));
      verbose("unlock: loading library");
      const { metadataById, accessMap: initialAccessMap } = await client.loadLibrary();
      const initialBookmarksMap = await client.loadBookmarksMap();

      txtKeyCache.current = new Map();
      setAccessMap(initialAccessMap);
      setBookmarksMap(initialBookmarksMap);
      setSession({ creds, client, r2Client: createR2Client(creds.r2Config), metadataById });
      setStatus("unlocked");
      setProgress(null);
      verbose("unlock: done");
    } catch (err) {
      verbose("unlock: failed", err);
      client?.terminate();
      setSession(null);
      setStatus("locked");
      setError(errorMessage(err) || "Failed to unlock your library.");
      setProgress(null);
    }
  }, []);

  const lock = useCallback(() => {
    txtKeyCache.current = new Map();
    session?.client.terminate();
    setSession(null);
    setAccessMap(new Map());
    setBookmarksMap(new Map());
    setStatus("locked");
    setError(null);
  }, [session]);

  // Re-opens against a fresh VFS/nested page-fetch worker (dbWorker.ts's
  // own refresh handler) so a document ingested elsewhere since unlock --
  // more pages, a higher page_count -- is actually visible: this session's
  // VFS pins the page_count/version it saw at open time, the same way any
  // snapshot-based reader does (docs/data_model.md).
  const refresh = useCallback(async () => {
    if (!session) throw new Error("vault is locked");
    setRefreshing(true);
    setProgress(phaseProgress(REFRESH_PHASES, 0));
    try {
      verbose("refresh: re-opening vault");
      await session.client.refresh();
      verbose("refresh: loading library");
      const { metadataById, accessMap: nextAccessMap } = await session.client.loadLibrary();
      setProgress(phaseProgress(REFRESH_PHASES, 1));
      const nextBookmarksMap = await session.client.loadBookmarksMap();

      txtKeyCache.current = new Map();
      setSession((prev) => (prev ? { ...prev, metadataById } : prev));
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
      const txtKey = await session.client.getTxtKey(txtId);
      txtKeyCache.current.set(txtId, txtKey);
      return txtKey;
    },
    [session],
  );

  const recordReadPosition = useCallback(
    async (txtId: number, position: ReadPosition) => {
      if (!session) throw new Error("vault is locked");
      await session.client.recordReadPosition(txtId, position);
      setAccessMap((prev) => new Map(prev).set(txtId, position));
    },
    [session],
  );

  const removeAccessEntry = useCallback(
    async (txtId: number) => {
      if (!session) throw new Error("vault is locked");
      await session.client.removeAccessEntry(txtId);
      setAccessMap((prev) => {
        const next = new Map(prev);
        next.delete(txtId);
        return next;
      });
    },
    [session],
  );

  const addBookmarkEntry = useCallback(
    async (txtId: number, partNum: number, line: number, preview: string) => {
      if (!session) throw new Error("vault is locked");
      setBookmarksMap(
        await session.client.addBookmarkEntry(txtId, partNum, line, preview, Date.now()),
      );
    },
    [session],
  );

  const removeBookmarkEntry = useCallback(
    async (bookmarkId: number) => {
      if (!session) throw new Error("vault is locked");
      setBookmarksMap(await session.client.removeBookmarkEntry(bookmarkId));
    },
    [session],
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
