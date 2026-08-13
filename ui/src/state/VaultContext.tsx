// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
//
// "Unlocked" means an InstantDB session plus this account's own unwrapped
// key hierarchy (session.ts's resolveSession) and its whole library
// (library.ts's loadLibrary) -- there's no per-account database/VFS/Worker
// to open anymore (see docs/data_model.md: every document is its own set of
// InstantDB rows plus per-part R2 objects, read directly). Everything here
// runs on the main thread.
//
// unlock() resolves the InstantDB session (firebaseAuth.signIn ->
// db.auth.signInWithIdToken -> session.ts's resolveSession), then loads the
// whole library (library.ts's loadLibrary) before marking the vault
// unlocked -- both steps use the same live instantDb client this context
// keeps around afterward, for reader.ts's per-document reads and for
// writing back read-position/bookmark updates.

import { id, tx } from "@instantdb/react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  clearReadPosition,
  encodeAccessContent,
  setReadPosition,
  type AccessMap,
  type ReadPosition,
} from "../data/access";
import { saveBookMetadata, type BookMetadataEdits } from "../data/adminBooks";
import {
  addBookmark,
  encodeBookmarksContent,
  removeBookmark,
  type BookmarksMap,
} from "../data/bookmarks";
import * as blob from "../crypto/blob";
import { bytesToBase64, zeroBytes } from "../crypto/bytes";
import { loadCredsFromFile } from "../data/creds";
import type { Creds } from "../data/creds";
import * as firebaseAuth from "../data/firebaseAuth";
import { createInstantClient } from "../data/instantClient";
import { loadLibrary, type LibraryDocKind } from "../data/library";
import type { BookInfo } from "../data/metadata";
import type { AdminR2WriteCreds, R2Config } from "../data/r2Config";
import { reloadKeyedMaps, resolveSession, type Session } from "../data/session";
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
  "Loading your books",
] as const;
const REFRESH_PHASES = ["Loading your books"] as const;

function phaseProgress(
  phases: readonly string[],
  index: number,
): VaultProgress {
  return { label: phases[index]!, step: index + 1, total: phases.length };
}

export interface VaultSession {
  /** Purely cosmetic -- shown in AccountFooter next to the person icon.
   * This account's own credStore.content.display_name (the canonical one,
   * set once at provisioning time and following the account regardless of
   * which unlock file is used) if set, else the unlock file's own
   * display_name, else the signed-in Firebase account's own email. */
  displayName: string | null | undefined;
  instantDb: any;
  /** InstantDB session token returned by signInWithIdToken. The R2 broker
   * sends it back as As-Token so InstantDB applies txt.view to the exact
   * document before the broker mints a prefix-scoped credential. */
  instantToken: string;
  authId: string;
  instantAppId: string;
  instantClientName: string;
  firebaseApiKey: string;
  isAdmin: boolean;
  umk: Uint8Array;
  keyStorePrivKey: Uint8Array;
  credStoreKey: Uint8Array;
  r2Config: R2Config;
  /** The admin's own real, static read-write R2 credential -- present only
   * for an isAdmin session. Used only by adminShares.ts's grantShare to
   * write the recipient's own re-encrypted copy of a shared document; every
   * other R2 read still goes through a Worker-minted temporary credential
   * (see session.ts). */
  adminR2WriteCreds?: AdminR2WriteCreds;
  metadataById: Map<string, BookInfo>;
  /** This account's own unwrapped txtKey for every document it can read --
   * reader.ts's only way to get one (see library.ts). */
  docKeys: Map<string, Uint8Array>;
  /** Which table each docKeys entry's row actually lives in -- see
   * library.ts's own LibrarySnapshot.docKinds. */
  docKinds: Map<string, LibraryDocKind>;
  txtAccess: { id: string | null; key: Uint8Array };
  txtBookmarks: { id: string | null; key: Uint8Array };
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
  recordReadPosition: (txtId: string, position: ReadPosition) => Promise<void>;
  removeAccessEntry: (txtId: string) => Promise<void>;
  addBookmarkEntry: (
    txtId: string,
    partNum: number,
    line: number,
    preview: string,
  ) => Promise<void>;
  removeBookmarkEntry: (txtId: string, bookmarkId: string) => Promise<void>;
  updateBookMetadata: (
    txtId: string,
    edits: BookMetadataEdits,
    onProgress?: (label: string) => void,
  ) => Promise<void>;
  syncBookInfo: (txtId: string, info: BookInfo) => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function elapsed(start: number): string {
  return `${(performance.now() - start).toFixed(1)}ms`;
}

/** Zeroes every sensitive Uint8Array a Session/VaultSession holds directly
 * (umk, keyStorePrivKey, credStoreKey, txtAccess/txtBookmarks' own key) --
 * called right before the last reference to one of these is dropped
 * (lock(), a failed unlock(), refresh() replacing a stale one), never on a
 * key still live in the current session. docKeys (VaultSession-only, absent
 * on a plain Session) needs its own pass since it's a Map, not a single
 * field -- see zeroDocKeys. */
function zeroKeyMaterial(keys: {
  umk: Uint8Array;
  keyStorePrivKey: Uint8Array;
  credStoreKey: Uint8Array;
  txtAccess: { key: Uint8Array };
  txtBookmarks: { key: Uint8Array };
}): void {
  zeroBytes(keys.umk);
  zeroBytes(keys.keyStorePrivKey);
  zeroBytes(keys.credStoreKey);
  zeroBytes(keys.txtAccess.key);
  zeroBytes(keys.txtBookmarks.key);
}

function zeroDocKeys(docKeys: Map<string, Uint8Array>): void {
  for (const key of docKeys.values()) zeroBytes(key);
}

/** Runs `task` after every previously queued task on this same queue has
 * settled -- used to serialize txtAccess/txtBookmarks writes (each is a
 * read-modify-write of one whole-account row, and the row's own id
 * transitions from null to real on its first write) so two rapid calls
 * (e.g. a page-turn's recordReadPosition firing again before the previous
 * one's create-if-missing finished) can't race into creating two rows. */
function useSerialQueue(): (task: () => Promise<void>) => Promise<void> {
  const chain = useRef<Promise<void>>(Promise.resolve());
  return useCallback((task: () => Promise<void>) => {
    const next = chain.current.then(task, task);
    chain.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);
}

async function resolveIdentity(file: File): Promise<{
  instantDb: any;
  instantToken: string;
  authId: string;
  creds: Creds;
  keys: Session;
  displayName: string | null | undefined;
}> {
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
  const instantToken: unknown = authResult.user.refresh_token;
  if (typeof instantToken !== "string" || instantToken.length === 0) {
    throw new Error("InstantDB sign-in returned no session token");
  }

  verbose("unlock: resolving session ($users/keyStore/credStore)");
  const keys = await resolveSession(instantDb, authId, creds.userRootKey);

  return {
    instantDb,
    instantToken,
    authId,
    creds,
    keys,
    displayName: keys.displayName ?? creds.displayName ?? authResult.user.email,
  };
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accessMap, setAccessMap] = useState<AccessMap>({});
  const [bookmarksMap, setBookmarksMap] = useState<BookmarksMap>({});
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<VaultProgress | null>(null);

  const accessQueue = useSerialQueue();
  const bookmarksQueue = useSerialQueue();

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    setProgress(phaseProgress(UNLOCK_PHASES, 0));
    // Tracked outside the try so a failure between resolveIdentity()
    // succeeding and loadLibrary() succeeding can still zero the keys it
    // already resolved, instead of just letting them fall out of scope
    // unzeroed on the way to the catch block below.
    let keys: Session | undefined;
    try {
      const resolved = await resolveIdentity(file);
      keys = resolved.keys;
      const { instantDb, instantToken, authId, creds, displayName } = resolved;

      setProgress(phaseProgress(UNLOCK_PHASES, 1));
      verbose("unlock: loading library");
      const libraryStart = performance.now();
      const { metadataById, docKeys, docKinds } = await loadLibrary(
        instantDb,
        keys,
      );
      verbose(`unlock: loadLibrary() done in ${elapsed(libraryStart)}`);

      setAccessMap(keys.txtAccess.content);
      setBookmarksMap(keys.txtBookmarks.content);
      setSession({
        displayName,
        instantDb,
        instantToken,
        authId,
        instantAppId: creds.instantAppId,
        instantClientName: creds.instantClientName,
        firebaseApiKey: creds.firebaseApiKey,
        isAdmin: keys.isAdmin,
        umk: keys.umk,
        keyStorePrivKey: keys.keyStorePrivKey,
        credStoreKey: keys.credStoreKey,
        r2Config: keys.r2Config,
        adminR2WriteCreds: keys.adminR2WriteCreds,
        metadataById,
        docKeys,
        docKinds,
        txtAccess: { id: keys.txtAccess.id, key: keys.txtAccess.key },
        txtBookmarks: { id: keys.txtBookmarks.id, key: keys.txtBookmarks.key },
      });
      setStatus("unlocked");
      setProgress(null);
      verbose("unlock: done");
    } catch (err) {
      verbose("unlock: failed", err);
      if (keys) zeroKeyMaterial(keys);
      setSession((prev) => {
        if (prev) {
          zeroKeyMaterial(prev);
          zeroDocKeys(prev.docKeys);
        }
        return null;
      });
      setStatus("locked");
      setError(errorMessage(err) || "Failed to unlock your library.");
      setProgress(null);
    }
  }, []);

  const lock = useCallback(() => {
    setSession((prev) => {
      if (prev) {
        zeroKeyMaterial(prev);
        zeroDocKeys(prev.docKeys);
      }
      return null;
    });
    setAccessMap({});
    setBookmarksMap({});
    setStatus("locked");
    setError(null);
  }, []);

  // Re-fetches the whole library (a document ingested/shared elsewhere since
  // unlock) and this account's own txtAccess/txtBookmarks content (in case
  // either changed from another tab/device) -- both only ever need the
  // already-known umk/keyStorePrivKey, never the original creds.json's
  // userRootKey (not retained after unlock), so this never re-derives the
  // account's identity from scratch the way unlock() does.
  const refresh = useCallback(async () => {
    if (!session) throw new Error("vault is locked");
    setRefreshing(true);
    setProgress(phaseProgress(REFRESH_PHASES, 0));
    try {
      verbose("refresh: reloading library");
      const [{ metadataById, docKeys, docKinds }, { txtAccess, txtBookmarks }] =
        await Promise.all([
          loadLibrary(session.instantDb, {
            authId: session.authId,
            umk: session.umk,
          }),
          reloadKeyedMaps(session.instantDb, session.authId, session.umk),
        ]);

      setSession((prev) => {
        if (!prev) return prev;
        // loadLibrary/reloadKeyedMaps always decrypt fresh Uint8Arrays --
        // the ones being replaced here are never the same instances as the
        // new docKeys/txtAccess.key/txtBookmarks.key below, so zeroing them
        // first can't clobber anything still in use.
        zeroDocKeys(prev.docKeys);
        zeroBytes(prev.txtAccess.key);
        zeroBytes(prev.txtBookmarks.key);
        return {
          ...prev,
          metadataById,
          docKeys,
          docKinds,
          txtAccess: { id: txtAccess.id, key: txtAccess.key },
          txtBookmarks: { id: txtBookmarks.id, key: txtBookmarks.key },
        };
      });
      setAccessMap(txtAccess.content);
      setBookmarksMap(txtBookmarks.content);
      verbose("refresh: done");
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  }, [session]);

  const recordReadPosition = useCallback(
    async (txtId: string, position: ReadPosition) => {
      if (!session) throw new Error("vault is locked");
      await accessQueue(async () => {
        const nextMap = setReadPosition(accessMap, txtId, position);
        await persistAccessMap(session, setSession, nextMap);
        setAccessMap(nextMap);
      });
    },
    [session, accessMap, accessQueue],
  );

  const removeAccessEntry = useCallback(
    async (txtId: string) => {
      if (!session) throw new Error("vault is locked");
      await accessQueue(async () => {
        const nextMap = clearReadPosition(accessMap, txtId);
        await persistAccessMap(session, setSession, nextMap);
        setAccessMap(nextMap);
      });
    },
    [session, accessMap, accessQueue],
  );

  const addBookmarkEntry = useCallback(
    async (txtId: string, partNum: number, line: number, preview: string) => {
      if (!session) throw new Error("vault is locked");
      await bookmarksQueue(async () => {
        const nextMap = addBookmark(
          bookmarksMap,
          txtId,
          partNum,
          line,
          preview,
          Date.now(),
        );
        await persistBookmarksMap(session, setSession, nextMap);
        setBookmarksMap(nextMap);
      });
    },
    [session, bookmarksMap, bookmarksQueue],
  );

  const removeBookmarkEntry = useCallback(
    async (txtId: string, bookmarkId: string) => {
      if (!session) throw new Error("vault is locked");
      await bookmarksQueue(async () => {
        const nextMap = removeBookmark(bookmarksMap, txtId, bookmarkId);
        await persistBookmarksMap(session, setSession, nextMap);
        setBookmarksMap(nextMap);
      });
    },
    [session, bookmarksMap, bookmarksQueue],
  );

  const syncBookInfo = useCallback((txtId: string, info: BookInfo) => {
    setSession((prev) => {
      if (!prev) return prev;
      const current = prev.metadataById.get(txtId);
      if (current === info) return prev;
      const metadataById = new Map(prev.metadataById);
      metadataById.set(txtId, info);
      return { ...prev, metadataById };
    });
  }, []);

  const updateBookMetadata = useCallback(
    async (
      txtId: string,
      edits: BookMetadataEdits,
      onProgress?: (label: string) => void,
    ) => {
      if (!session) throw new Error("vault is locked");
      const info = await saveBookMetadata(
        session.instantDb,
        session,
        txtId,
        edits,
        onProgress,
      );
      syncBookInfo(txtId, info);
    },
    [session, syncBookInfo],
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
      updateBookMetadata,
      syncBookInfo,
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
      updateBookMetadata,
      syncBookInfo,
    ],
  );

  return (
    <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
  );
}

/** Re-encrypts the whole accessMap and writes it back to this account's own
 * txtAccess row, creating it (with a freshly minted txtAccessKey) the first
 * time this account ever records a read position. Mutates session.txtAccess
 * in place via setSession once a fresh row id exists, so a later call in
 * the same session updates instead of creating a second row. */
async function persistAccessMap(
  session: VaultSession,
  setSession: (
    updater: (prev: VaultSession | null) => VaultSession | null,
  ) => void,
  nextMap: AccessMap,
): Promise<void> {
  const payload = JSON.stringify(encodeAccessContent(nextMap));
  const contentBlob = await blob.encrypt(
    session.txtAccess.key,
    new TextEncoder().encode(payload),
    { compressed: true },
  );
  const content = bytesToBase64(contentBlob);
  if (session.txtAccess.id) {
    await session.instantDb.transact(
      tx.txtAccess[session.txtAccess.id]!.update({ content }),
    );
    return;
  }
  const newId = id();
  const keyBlob = await blob.encrypt(session.umk, session.txtAccess.key);
  await session.instantDb.transact(
    tx.txtAccess[newId]!.update({
      txtAccessKey: bytesToBase64(keyBlob),
      content,
    }).link({ owner: session.authId }),
  );
  setSession((prev) =>
    prev ? { ...prev, txtAccess: { ...prev.txtAccess, id: newId } } : prev,
  );
}

/** Same shape as persistAccessMap, for this account's own txtBookmarks row. */
async function persistBookmarksMap(
  session: VaultSession,
  setSession: (
    updater: (prev: VaultSession | null) => VaultSession | null,
  ) => void,
  nextMap: BookmarksMap,
): Promise<void> {
  const payload = JSON.stringify(encodeBookmarksContent(nextMap));
  const contentBlob = await blob.encrypt(
    session.txtBookmarks.key,
    new TextEncoder().encode(payload),
    { compressed: true },
  );
  const content = bytesToBase64(contentBlob);
  if (session.txtBookmarks.id) {
    await session.instantDb.transact(
      tx.txtBookmarks[session.txtBookmarks.id]!.update({ content }),
    );
    return;
  }
  const newId = id();
  const keyBlob = await blob.encrypt(session.umk, session.txtBookmarks.key);
  await session.instantDb.transact(
    tx.txtBookmarks[newId]!.update({
      txtBookmarkKey: bytesToBase64(keyBlob),
      content,
    }).link({ owner: session.authId }),
  );
  setSession((prev) =>
    prev
      ? { ...prev, txtBookmarks: { ...prev.txtBookmarks, id: newId } }
      : prev,
  );
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error("useVault() must be used within a VaultProvider");
  }
  return ctx;
}
