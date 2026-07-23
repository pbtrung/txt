// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
//
// A plain module-level singleton, not a Vue provide/inject context: there is
// never more than one vault instance in this app, so provide/inject would
// just be boilerplate around something a bare export already does -- and
// (unlike a context, which only components can consume) this needs to be
// readable from the router's navigation guard too (see router.ts), which
// runs outside any component's setup().

import type { Client } from "@libsql/core/api";
import type { AwsClient } from "aws4fetch";
import { ref, shallowRef } from "vue";

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const status = ref<VaultStatus>("locked");
const session = shallowRef<VaultSession | null>(null);
const error = ref<string | null>(null);
// shallowRef, not ref: both maps are always replaced wholesale (never
// mutated in place -- see setAccessMap/setBookmarksMap below), so there's
// nothing for Vue's deep reactivity to usefully track inside them.
const accessMap = shallowRef<AccessMap>(new Map());
const bookmarksMap = shallowRef<BookmarksMap>(new Map());

// Plain module state, not refs -- neither is ever rendered, so there's
// nothing to make reactive. txtKeyCache used to be a React useRef purely to
// survive re-renders without resetting; a module-level singleton doesn't
// need that at all.
let txtKeyCache = new Map<number, Uint8Array>();

function setAccessMap(next: AccessMap): void {
  accessMap.value = next;
}
function setBookmarksMap(next: BookmarksMap): void {
  bookmarksMap.value = next;
}

// Serializes recordReadPosition/removeAccessEntry/addBookmarkEntry/
// removeBookmarkEntry: each reads accessMap.value/bookmarksMap.value,
// computes the next map, and only updates it once its own DB write settles
// -- so two calls fired back to back (before either awaits) would otherwise
// both read the *same* pre-mutation map and race to overwrite each other's
// write with a full-blob UPDATE that doesn't know about the other's change.
// (Vue's refs are already synchronously up to date the instant they're set
// -- unlike React state, there's no separate "ref mirror" needed just to
// read the latest value across a render cycle -- but the *async DB write*
// itself still needs this queue: without it, two calls could each read the
// same starting map before either write lands, and whichever write finishes
// last would silently discard the other's change.) Queuing every mutation
// through this one promise chain ensures each starts only after the
// previous one's map update has landed, so it always builds on the latest
// state instead of a stale one.
let mutationQueue: Promise<unknown> = Promise.resolve();
function enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function unlock(file: File): Promise<void> {
  status.value = "unlocking";
  error.value = null;
  try {
    verbose("unlock: reading config file", file.name);
    const text = await file.text();
    const creds = parseCreds(JSON.parse(text));
    verbose("unlock: config parsed for username", creds.username);

    const db = createDb(creds);
    verbose("unlock: resolving user id");
    const userId = await resolveUserId(db, creds);
    verbose("unlock: resolved user id", userId);

    verbose("unlock: checking password");
    const passwordOk = await checkPassword(db, userId, creds.password);
    if (!passwordOk) {
      throw new Error("Incorrect password for this account.");
    }
    verbose("unlock: password OK");

    verbose("unlock: unwrapping umk");
    const umk = await unwrapUmk(db, creds, userId);
    verbose("unlock: fetching r2 config");
    const r2Config = await fetchR2Config(db, userId, umk);
    const r2Client = createR2Client(r2Config);

    // Everything the Library screen needs, loaded once here rather than
    // per-book: exactly three requests (metadata, access, bookmarks), each
    // a single row scoped to this user.
    verbose("unlock: loading txt metadata");
    const metadataById = await loadTxtMetadata(db, userId, umk);
    verbose("unlock: loading access map");
    const { txtAccessKey, accessMap: initialAccessMap } = await loadOrInitAccess(db, userId, umk);
    verbose("unlock: loading bookmarks");
    const { bookmarkKey, bookmarksMap: initialBookmarksMap } = await loadOrInitBookmarks(db, userId, umk);

    txtKeyCache = new Map();
    setAccessMap(initialAccessMap);
    setBookmarksMap(initialBookmarksMap);
    session.value = { creds, db, userId, umk, r2Config, r2Client, metadataById, txtAccessKey, bookmarkKey };
    status.value = "unlocked";
    verbose("unlock: done");
  } catch (err) {
    verbose("unlock: failed", err);
    session.value = null;
    status.value = "locked";
    error.value = errorMessage(err) || "Failed to unlock your library.";
  }
}

function lock(): void {
  txtKeyCache = new Map();
  session.value = null;
  setAccessMap(new Map());
  setBookmarksMap(new Map());
  status.value = "locked";
  error.value = null;
}

async function getTxtKey(txtId: number): Promise<Uint8Array> {
  const cached = txtKeyCache.get(txtId);
  if (cached) return cached;
  if (!session.value) {
    throw new Error("vault is locked");
  }
  const txtKey = await unwrapTxtKey(session.value.db, txtId, session.value.umk);
  txtKeyCache.set(txtId, txtKey);
  return txtKey;
}

async function recordReadPosition(txtId: number, position: ReadPosition): Promise<void> {
  if (!session.value) throw new Error("vault is locked");
  const current = session.value;
  await enqueueMutation(async () => {
    const next = await setReadPositionData(
      current.db,
      current.userId,
      current.txtAccessKey,
      accessMap.value,
      txtId,
      position,
    );
    setAccessMap(next);
  });
}

async function removeAccessEntry(txtId: number): Promise<void> {
  if (!session.value) throw new Error("vault is locked");
  const current = session.value;
  await enqueueMutation(async () => {
    const next = await removeAccessEntryData(current.db, current.userId, current.txtAccessKey, accessMap.value, txtId);
    setAccessMap(next);
  });
}

async function addBookmarkEntry(txtId: number, partNum: number, line: number, txtPreview: string): Promise<void> {
  if (!session.value) throw new Error("vault is locked");
  const current = session.value;
  await enqueueMutation(async () => {
    const next = await addBookmarkData(
      current.db,
      current.userId,
      current.bookmarkKey,
      bookmarksMap.value,
      txtId,
      partNum,
      line,
      txtPreview,
    );
    setBookmarksMap(next);
  });
}

async function removeBookmarkEntry(txtId: number, createdAt: number): Promise<void> {
  if (!session.value) throw new Error("vault is locked");
  const current = session.value;
  await enqueueMutation(async () => {
    const next = await removeBookmarkData(
      current.db,
      current.userId,
      current.bookmarkKey,
      bookmarksMap.value,
      txtId,
      createdAt,
    );
    setBookmarksMap(next);
  });
}

export interface Vault {
  status: typeof status;
  session: typeof session;
  error: typeof error;
  accessMap: typeof accessMap;
  bookmarksMap: typeof bookmarksMap;
  unlock: typeof unlock;
  lock: typeof lock;
  getTxtKey: typeof getTxtKey;
  recordReadPosition: typeof recordReadPosition;
  removeAccessEntry: typeof removeAccessEntry;
  addBookmarkEntry: typeof addBookmarkEntry;
  removeBookmarkEntry: typeof removeBookmarkEntry;
}

/** The one vault instance this whole app shares -- see the module comment. */
export function useVault(): Vault {
  return {
    status,
    session,
    error,
    accessMap,
    bookmarksMap,
    unlock,
    lock,
    getTxtKey,
    recordReadPosition,
    removeAccessEntry,
    addBookmarkEntry,
    removeBookmarkEntry,
  };
}
