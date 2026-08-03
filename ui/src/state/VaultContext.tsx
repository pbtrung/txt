// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
//
// "Unlocked" means a real SQLCipher database is open against a lazy remote
// VFS -- but that db/VFS/commit state all lives inside a dedicated Worker
// (data/dbWorker.ts), not here: a real browser forbids Atomics.wait()
// outside a Worker, which remoteVfs.ts's xRead needs to bridge SQLite's
// synchronous WASM callback to a page fetch, so SQLite itself has to run
// there instead of on the main thread. This file only ever talks to that
// Worker through DbWorkerClient's small RPC surface.
//
// unlock() itself resolves the InstantDB session on the main thread
// (firebaseAuth.signIn -> db.auth.signInWithIdToken -> session.ts's
// resolveSession) before ever opening the Worker -- dbWorker.open() takes
// the already-resolved coordinates (r2Config/pathKey/dbKey/dbMetaId/
// currentVersion/pageCount/pageSize) directly, rather than re-deriving them
// itself, since it needs its own independent InstantDB session anyway (a
// Worker can't share this thread's live client object) and there's no
// reason to redo the same queryOnce+unwrap chain twice.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { AccessMap, ReadPosition } from "../data/access";
import type { BookmarksMap } from "../data/bookmarks";
import { loadCredsFromFile } from "../data/creds";
import { DbWorkerClient } from "../data/dbWorkerClient";
import * as firebaseAuth from "../data/firebaseAuth";
import { createInstantClient } from "../data/instantClient";
import type { BookInfo } from "../data/metadata";
import { resolveSession } from "../data/session";
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
const REFRESH_PHASES = [
  "Loading your books",
  "Loading your bookmarks",
] as const;

function phaseProgress(
  phases: readonly string[],
  index: number,
): VaultProgress {
  return { label: phases[index], step: index + 1, total: phases.length };
}

export interface VaultSession {
  /** Purely cosmetic -- shown in AccountFooter next to the person icon.
   * The creds file's own display_name if it set one, otherwise the
   * signed-in Firebase account's own email. */
  displayName: string | null | undefined;
  client: DbWorkerClient;
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

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMap, setAccessMap] = useState<AccessMap>(new Map());
  const [bookmarksMap, setBookmarksMap] = useState<BookmarksMap>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<VaultProgress | null>(null);

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    setProgress(phaseProgress(UNLOCK_PHASES, 0));
    let client: DbWorkerClient | null = null;
    try {
      verbose("unlock: reading creds file", file.name);
      const creds = await loadCredsFromFile(file);

      verbose("unlock: signing in with Firebase");
      const { idToken } = await firebaseAuth.signIn(
        {
          apiKey: creds.firebaseApiKey,
          authDomain: creds.firebaseAuthDomain,
          projectId: creds.firebaseProjectId,
        },
        creds.firebaseEmail,
        creds.firebasePassword,
      );
      const instantDb = createInstantClient(creds.instantAppId);
      const authResult = await instantDb.auth.signInWithIdToken({
        clientName: creds.instantClientName,
        idToken,
      });
      const authId: string = authResult.user.id;

      verbose("unlock: resolving session ($users/dbMeta/credStore)");
      const sessionKeys = await resolveSession(
        instantDb,
        authId,
        creds.userRootKey,
      );

      setProgress(phaseProgress(UNLOCK_PHASES, 1));
      verbose(
        "unlock: opening vault against the lazy remote VFS (in a worker)",
      );
      client = new DbWorkerClient();
      const openStart = performance.now();
      await client.open({
        instantAppId: creds.instantAppId,
        instantClientName: creds.instantClientName,
        idToken,
        authId,
        dbMetaId: sessionKeys.dbMetaId,
        currentVersion: sessionKeys.currentVersion,
        pageCount: sessionKeys.pageCount,
        pageSize: sessionKeys.pageSize,
        r2Config: sessionKeys.r2Config,
        pathKey: sessionKeys.pathKey,
        dbKey: sessionKeys.dbKey,
      });
      verbose(`unlock: open() done in ${elapsed(openStart)}`);

      // Each of these can trigger a burst of individual page fetches
      // (remotePageWorker.ts logs each one) if their rows/indexes aren't
      // already resident in remoteVfs.ts's page cache -- timing them
      // separately here shows which one actually dominates a slow unlock,
      // rather than only seeing this whole phase's total.
      setProgress(phaseProgress(UNLOCK_PHASES, 2));
      verbose("unlock: loading library");
      const libraryStart = performance.now();
      const { metadataById, accessMap: initialAccessMap } =
        await client.loadLibrary();
      verbose(`unlock: loadLibrary() done in ${elapsed(libraryStart)}`);
      const bookmarksStart = performance.now();
      const initialBookmarksMap = await client.loadBookmarksMap();
      verbose(`unlock: loadBookmarksMap() done in ${elapsed(bookmarksStart)}`);

      const vfsStats = await client.getVfsStats();
      verbose(
        `unlock: ${vfsStats.roundtrips.length} page fetch(es) beyond the prefetch, ` +
          `${vfsStats.bytesFetched} byte(s)`,
      );

      setAccessMap(initialAccessMap);
      setBookmarksMap(initialBookmarksMap);
      setSession({
        displayName: creds.displayName ?? authResult.user.email,
        client,
        metadataById,
      });
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
      const { metadataById, accessMap: nextAccessMap } =
        await session.client.loadLibrary();
      setProgress(phaseProgress(REFRESH_PHASES, 1));
      const nextBookmarksMap = await session.client.loadBookmarksMap();

      setSession((prev) => (prev ? { ...prev, metadataById } : prev));
      setAccessMap(nextAccessMap);
      setBookmarksMap(nextBookmarksMap);
      verbose("refresh: done");
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  }, [session]);

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
        await session.client.addBookmarkEntry(
          txtId,
          partNum,
          line,
          preview,
          Date.now(),
        ),
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
      recordReadPosition,
      removeAccessEntry,
      addBookmarkEntry,
      removeBookmarkEntry,
    ],
  );

  return (
    <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
  );
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error("useVault() must be used within a VaultProvider");
  }
  return ctx;
}
