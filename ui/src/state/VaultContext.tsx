// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.

import type { Client } from "@libsql/core/api";
import type { AwsClient } from "aws4fetch";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import {
  loadOrInitAccess,
  removeAccessEntry as removeAccessEntryData,
  setReadPosition as setReadPositionData,
  type AccessMap,
  type ReadPosition,
} from "../data/access";
import {
  addBookmark as addBookmarkData,
  loadOrInitBookmarks,
  removeBookmark as removeBookmarkData,
  type BookmarksMap,
} from "../data/bookmarks";
import { checkPassword, fetchR2Config, resolveUserId, unwrapTxtKey, unwrapUmk } from "../data/owner";
import { createDb } from "../data/db";
import { createR2Client } from "../data/r2";
import { parseCreds, type Creds } from "../data/creds";
import { loadTxtMetadata, type BookInfo } from "../data/metadata";
import type { R2Config } from "../data/r2Config";
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
  "Signing you in",
  "Unwrapping your keys",
  "Loading your books",
  "Loading your read progress",
  "Loading your bookmarks",
] as const;
const REFRESH_PHASES = ["Loading your books", "Loading your read progress", "Loading your bookmarks"] as const;

function phaseProgress(phases: readonly string[], index: number): VaultProgress {
  return { label: phases[index], step: index + 1, total: phases.length };
}

export interface VaultSession {
  creds: Creds;
  db: Client;
  userId: number;
  umk: Uint8Array;
  r2Config: R2Config;
  r2Client: AwsClient;
  metadataById: Map<number, BookInfo>;
  txtAccessKey: Uint8Array;
  bookmarkKey: Uint8Array;
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
  addBookmarkEntry: (txtId: number, partNum: number, line: number, txtPreview: string) => Promise<void>;
  removeBookmarkEntry: (txtId: number, createdAt: number) => Promise<void>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMap, setAccessMapState] = useState<AccessMap>(new Map());
  const [bookmarksMap, setBookmarksMapState] = useState<BookmarksMap>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  const txtKeyCache = useRef(new Map<number, Uint8Array>());

  // Mirrors of the two maps above, updated synchronously (unlike state,
  // which only lands after a re-render) -- mutators read from these so two
  // rapid-fire calls (e.g. bookmarking two lines back to back) each build on
  // the other's result instead of both starting from the same stale map.
  const accessMapRef = useRef<AccessMap>(accessMap);
  const bookmarksMapRef = useRef<BookmarksMap>(bookmarksMap);

  const setAccessMap = useCallback((next: AccessMap) => {
    accessMapRef.current = next;
    setAccessMapState(next);
  }, []);
  const setBookmarksMap = useCallback((next: BookmarksMap) => {
    bookmarksMapRef.current = next;
    setBookmarksMapState(next);
  }, []);

  // Serializes recordReadPosition/removeAccessEntry/addBookmarkEntry/
  // removeBookmarkEntry: each reads accessMapRef/bookmarksMapRef, computes
  // the next map, and only updates that ref once its own DB write settles --
  // so two calls fired back to back (before either awaits) would otherwise
  // both read the *same* pre-mutation ref value and race to overwrite each
  // other's write with a full-blob UPDATE that doesn't know about the
  // other's change. Queuing every mutation through this one promise chain
  // ensures each starts only after the previous one's ref update has
  // landed, so it always builds on the latest state instead of a stale one.
  const mutationQueue = useRef(Promise.resolve());
  const enqueueMutation = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.current.then(run, run);
    mutationQueue.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const unlock = useCallback(
    async (file: File) => {
      setStatus("unlocking");
      setError(null);
      setProgress(null);
      try {
        verbose("unlock: reading config file", file.name);
        const text = await file.text();
        const creds = parseCreds(JSON.parse(text));
        verbose("unlock: config parsed for username", creds.username);

        const db = createDb(creds);
        setProgress(phaseProgress(UNLOCK_PHASES, 0));
        verbose("unlock: resolving user id");
        const userId = await resolveUserId(db, creds);
        verbose("unlock: resolved user id", userId);

        verbose("unlock: checking password");
        const passwordOk = await checkPassword(db, userId, creds.password);
        if (!passwordOk) {
          throw new Error("Incorrect password for this account.");
        }
        verbose("unlock: password OK");

        setProgress(phaseProgress(UNLOCK_PHASES, 1));
        verbose("unlock: unwrapping umk");
        const umk = await unwrapUmk(db, creds, userId);
        verbose("unlock: fetching r2 config");
        const r2Config = await fetchR2Config(db, userId, umk);
        const r2Client = createR2Client(r2Config);

        // Everything the Library screen needs, loaded once here rather than
        // per-book: exactly three requests (metadata, access, bookmarks),
        // each a single row scoped to this user.
        setProgress(phaseProgress(UNLOCK_PHASES, 2));
        verbose("unlock: loading txt metadata");
        const metadataById = await loadTxtMetadata(db, userId, umk, r2Client, r2Config);
        setProgress(phaseProgress(UNLOCK_PHASES, 3));
        verbose("unlock: loading access map");
        const { txtAccessKey, accessMap: initialAccessMap } = await loadOrInitAccess(db, userId, umk);
        setProgress(phaseProgress(UNLOCK_PHASES, 4));
        verbose("unlock: loading bookmarks");
        const { bookmarkKey, bookmarksMap: initialBookmarksMap } = await loadOrInitBookmarks(db, userId, umk);

        txtKeyCache.current = new Map();
        setAccessMap(initialAccessMap);
        setBookmarksMap(initialBookmarksMap);
        setSession({ creds, db, userId, umk, r2Config, r2Client, metadataById, txtAccessKey, bookmarkKey });
        setStatus("unlocked");
        setProgress(null);
        verbose("unlock: done");
      } catch (err) {
        verbose("unlock: failed", err);
        setSession(null);
        setStatus("locked");
        setError(errorMessage(err) || "Failed to unlock your library.");
        setProgress(null);
      }
    },
    [setAccessMap, setBookmarksMap],
  );

  const lock = useCallback(() => {
    txtKeyCache.current = new Map();
    setSession(null);
    setAccessMap(new Map());
    setBookmarksMap(new Map());
    setStatus("locked");
    setError(null);
  }, [setAccessMap, setBookmarksMap]);

  // Re-loads exactly the three requests unlock() makes up front (metadata,
  // access, bookmarks) -- for the Library screen's manual refresh button,
  // so a book ingested/shared, or a bookmark/read-position added, from
  // elsewhere since unlocking shows up without a full re-unlock. Rethrows
  // on failure rather than swallowing it (unlike the best-effort per-user
  // blob *writes* elsewhere in this file) so the Library screen's button
  // can surface it -- the user explicitly asked for fresh data, so a
  // silent no-op would be misleading.
  const refresh = useCallback(async () => {
    if (!session) throw new Error("vault is locked");
    setRefreshing(true);
    setProgress(phaseProgress(REFRESH_PHASES, 0));
    try {
      verbose("refresh: loading txt metadata");
      const metadataById = await loadTxtMetadata(
        session.db,
        session.userId,
        session.umk,
        session.r2Client,
        session.r2Config,
      );
      setProgress(phaseProgress(REFRESH_PHASES, 1));
      verbose("refresh: loading access map");
      const { txtAccessKey, accessMap: nextAccessMap } = await loadOrInitAccess(
        session.db,
        session.userId,
        session.umk,
      );
      setProgress(phaseProgress(REFRESH_PHASES, 2));
      verbose("refresh: loading bookmarks");
      const { bookmarkKey, bookmarksMap: nextBookmarksMap } = await loadOrInitBookmarks(
        session.db,
        session.userId,
        session.umk,
      );

      setSession((prev) => (prev ? { ...prev, metadataById, txtAccessKey, bookmarkKey } : prev));
      setAccessMap(nextAccessMap);
      setBookmarksMap(nextBookmarksMap);
      verbose("refresh: done");
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  }, [session, setAccessMap, setBookmarksMap]);

  const getTxtKey = useCallback(
    async (txtId: number): Promise<Uint8Array> => {
      const cached = txtKeyCache.current.get(txtId);
      if (cached) return cached;
      if (!session) {
        throw new Error("vault is locked");
      }
      const txtKey = await unwrapTxtKey(session.db, txtId, session.umk);
      txtKeyCache.current.set(txtId, txtKey);
      return txtKey;
    },
    [session],
  );

  const recordReadPosition = useCallback(
    async (txtId: number, position: ReadPosition) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        const next = await setReadPositionData(
          session.db,
          session.userId,
          session.txtAccessKey,
          accessMapRef.current,
          txtId,
          position,
        );
        setAccessMap(next);
      });
    },
    [session, setAccessMap, enqueueMutation],
  );

  const removeAccessEntry = useCallback(
    async (txtId: number) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        const next = await removeAccessEntryData(
          session.db,
          session.userId,
          session.txtAccessKey,
          accessMapRef.current,
          txtId,
        );
        setAccessMap(next);
      });
    },
    [session, setAccessMap, enqueueMutation],
  );

  const addBookmarkEntry = useCallback(
    async (txtId: number, partNum: number, line: number, txtPreview: string) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        const next = await addBookmarkData(
          session.db,
          session.userId,
          session.bookmarkKey,
          bookmarksMapRef.current,
          txtId,
          partNum,
          line,
          txtPreview,
        );
        setBookmarksMap(next);
      });
    },
    [session, setBookmarksMap, enqueueMutation],
  );

  const removeBookmarkEntry = useCallback(
    async (txtId: number, createdAt: number) => {
      if (!session) throw new Error("vault is locked");
      await enqueueMutation(async () => {
        const next = await removeBookmarkData(
          session.db,
          session.userId,
          session.bookmarkKey,
          bookmarksMapRef.current,
          txtId,
          createdAt,
        );
        setBookmarksMap(next);
      });
    },
    [session, setBookmarksMap, enqueueMutation],
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
