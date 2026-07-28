// Decrypts+parses txt_metadata.content and normalizes each entry's OPF
// metadata (txt/opf.py's shape: dc:* local tag names, Calibre `meta
// name/content` pairs, repeated tags collapsed into a list -- see
// docs/data_model.md's txt_metadata) into a tolerant BookInfo, mirroring
// txt/download.py's _txt_names but keeping the full metadata, not just name.
//
// content is a wrapped R2 path (like txt_parts.path), not the JSON directly,
// for any account that's been migrated -- see docs/data_model.md and
// txt/owner.py's _txt_metadata_key_and_content, which this mirrors: content
// blobs at/above TXT_METADATA_LEGACY_THRESHOLD bytes are assumed to be an
// account not yet migrated off the old inline-JSON format.

import type { AwsClient } from "aws4fetch";
import type { Client } from "@libsql/core/api";

import * as base32 from "./base32";
import * as blob from "../crypto/blob";
import { randomBytes } from "../crypto/bytes";
import * as c from "../crypto/constants";
import { decryptJson } from "./decryptJson";
import { requireBlobBytes } from "./db";
import { getObject, putObject } from "./r2";
import type { R2Config } from "./r2Config";

export interface MetadataField {
  key: string;
  values: string[];
}

export interface BookInfo {
  txtId: number;
  /** Original ingested filename -- always present, the fallback title. */
  name: string;
  title: string;
  author?: string;
  subjects: string[];
  publisher?: string;
  description?: string;
  series?: string;
  seriesIndex?: string;
  /** Every OPF/Calibre field this book's metadata carries, verbatim key
   * names and all values -- not just the curated subset above. The fields
   * above exist for their own special-purpose rendering (title in the top
   * bar, description's sanitized/truncated HTML, ...); this is for Reader's
   * Info dropdown to show the complete record underneath that summary. */
  rawMetadata: MetadataField[];
}

// opf.py's parse_opf_metadata shape: a plain string, or {text, ...attrs} if
// the source element had attributes, or a list of either for repeated tags.
type OpfValue = string | { text: string; [attr: string]: string } | OpfValue[];
type OpfMetadata = Record<string, OpfValue>;
export interface TxtMetadataEntry {
  name: string;
  metadata?: OpfMetadata;
}

function textOf(value: OpfValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return textOf(value[0]);
  return value.text;
}

function textsOf(value: OpfValue | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((v) => textOf(v)).filter((s): s is string => Boolean(s));
  }
  const single = textOf(value);
  return single ? [single] : [];
}

// Calibre's own bookkeeping (a numeric star rating, a sort-friendly title
// variant like "White Order, The"), plus two fields already surfaced with
// their own special-purpose rendering in the curated summary above this
// section (description gets sanitized/truncated HTML, subject becomes
// badges) -- showing them again here as raw text would just be redundant.
const HIDDEN_METADATA_KEYS = new Set(["calibre:rating", "calibre:title_sort", "description", "subject"]);

// Internal field names shown under their plainer meaning instead.
const RENAMED_METADATA_KEYS: Record<string, string> = {
  "calibre:timestamp": "timestamp",
  "calibre:series": "series",
  "calibre:series_index": "series index",
};

// Both are ISO-8601-ish timestamps in OPF/Calibre metadata (dc:date,
// calibre:timestamp) -- worth reformatting for a human reader rather than
// showing the raw "2020-01-15T00:00:00+00:00" string verbatim.
const DATE_METADATA_KEYS = new Set(["date", "calibre:timestamp"]);

const OPF_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?/;

/** Formats an OPF/Calibre timestamp for a human reader: "January 15, 2020"
 * if the time-of-day is absent or all-zero (a date with no meaningful time
 * component, which is the common case for dc:date), otherwise "January 15,
 * 2020, 8:23 AM". Parses the literal date/time digits in the string directly
 * -- rather than handing it to `Date` and letting the browser convert
 * through the viewer's own timezone -- so the calendar date shown always
 * matches what was actually recorded, never shifted by a day near midnight.
 * Falls back to the raw string if it doesn't look like an OPF timestamp. */
function formatOpfDate(raw: string): string {
  const match = OPF_DATE_RE.exec(raw);
  if (!match) return raw;
  const [, year, month, day, hour, minute, second] = match;
  const hasTime = hour !== undefined;
  const isMidnight = hasTime && hour === "00" && minute === "00" && second === "00";
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0)));
  const dateText = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  if (!hasTime || isMidnight) return dateText;
  const timeText = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    date,
  );
  return `${dateText}, ${timeText}`;
}

function toRawMetadata(md: OpfMetadata): MetadataField[] {
  return Object.entries(md)
    .filter(([key]) => !HIDDEN_METADATA_KEYS.has(key))
    .map(([key, value]) => {
      const values = textsOf(value);
      return {
        key: RENAMED_METADATA_KEYS[key] ?? key,
        values: DATE_METADATA_KEYS.has(key) ? values.map(formatOpfDate) : values,
      };
    })
    .filter((field) => field.values.length > 0);
}

function toBookInfo(txtId: number, entry: TxtMetadataEntry): BookInfo {
  const md = entry.metadata ?? {};
  return {
    txtId,
    name: entry.name,
    title: textOf(md.title) ?? entry.name,
    author: textOf(md.creator),
    subjects: textsOf(md.subject),
    publisher: textOf(md.publisher),
    description: textOf(md.description),
    series: textOf(md["calibre:series"]),
    seriesIndex: textOf(md["calibre:series_index"]),
    rawMetadata: toRawMetadata(md),
  };
}

/** Exported so VaultContext can cache this on the session (populated at
 * unlock/refresh) and hand it back to saveBookMetadata/
 * removeTxtMetadataEntry, letting an edit or delete skip re-fetching +
 * re-decrypting + re-decompressing this account's whole txt_metadata R2
 * object -- often the actual bottleneck, since it holds every book's
 * metadata in one blob, not just the one being touched. */
export interface RawMetadataState {
  txtMetadataKey: Uint8Array;
  content: Record<string, TxtMetadataEntry>;
  /** The current R2 raw_path, once migrated -- null if there's no content
   * yet, or the account is still on the pre-R2-indirection inline-JSON
   * format (see txt/owner.py's _txt_metadata_key_and_content, which this
   * mirrors). Writers (persistMetadataContent) use this to decide whether
   * to reuse an existing path in place or establish a fresh one. */
  rawPath: string | null;
}

/** Tolerates an R2-hosted metadata body that's *supposed* to be
 * brotli-compressed (txt/owner.py's _write_txt_metadata_content always
 * writes it that way) but, for at least one already-deployed account,
 * wasn't -- rather than assuming the documented shape and failing decode
 * for objects that predate it holding true. */
async function tolerantDecryptJson(key: Uint8Array, body: Uint8Array): Promise<unknown> {
  try {
    return await decryptJson(key, body);
  } catch {
    const plaintext = await blob.decrypt(key, body, false);
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
}

/** Resolves this account's txt_metadata_key, decrypted content, and current
 * R2 raw_path (if any) -- the shared read path behind loadTxtMetadata and
 * every write below. A write only re-fetches via this when its caller
 * doesn't already have a cached RawMetadataState to hand back in (see
 * saveBookMetadata/removeTxtMetadataEntry's own cachedState parameter) --
 * trading a fresh-read guarantee for not re-downloading this account's
 * entire metadata blob on every single edit. VaultContext is expected to
 * keep its cached copy in lockstep with every save/delete it makes (and
 * to only trust it between explicit refreshes), the same tradeoff already
 * accepted for metadataById/accessMap/bookmarksMap not tracking changes
 * made outside the current session (e.g. a concurrent --txt-ingest) until
 * the next Refresh. */
async function loadRawMetadataState(
  db: Client,
  userId: number,
  umk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
): Promise<RawMetadataState | null> {
  const result = await db.execute({
    sql: "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
    args: [userId],
  });
  const row = result.rows[0];
  if (!row) return null;
  const txtMetadataKey = await blob.decrypt(
    umk,
    requireBlobBytes(row.txt_metadata_key, "txt_metadata.txt_metadata_key"),
  );
  if (row.content === null) {
    return { txtMetadataKey, content: {}, rawPath: null };
  }
  const contentBlob = requireBlobBytes(row.content, "txt_metadata.content");
  if (contentBlob.length >= c.TXT_METADATA_LEGACY_THRESHOLD) {
    const content = (await decryptJson(txtMetadataKey, contentBlob)) as Record<string, TxtMetadataEntry>;
    return { txtMetadataKey, content, rawPath: null };
  }
  const rawPath = new TextDecoder().decode(await blob.decrypt(txtMetadataKey, contentBlob));
  const body = await getObject(r2Client, r2Config, rawPath);
  const content = (await tolerantDecryptJson(txtMetadataKey, body)) as Record<string, TxtMetadataEntry>;
  return { txtMetadataKey, content, rawPath };
}

export interface LoadedTxtMetadata {
  /** Null only if this account has no txt_metadata row at all (no txt
   * ingested yet) -- pass straight through as VaultContext's cached
   * rawMetadataState. */
  state: RawMetadataState | null;
  metadataById: Map<number, BookInfo>;
}

/** All of this account's book metadata, keyed by txt_id (empty if the
 * account has no txt yet), plus the raw state it was derived from --
 * VaultContext caches that raw state on the session (populated here, at
 * unlock/refresh) so a later edit/delete can reuse it instead of paying
 * for this same fetch+decrypt+decompress all over again. */
export async function loadTxtMetadata(
  db: Client,
  userId: number,
  umk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
): Promise<LoadedTxtMetadata> {
  const state = await loadRawMetadataState(db, userId, umk, r2Client, r2Config);
  if (!state) return { state: null, metadataById: new Map() };
  const metadataById = new Map<number, BookInfo>();
  for (const [txtIdStr, entry] of Object.entries(state.content)) {
    const txtId = Number(txtIdStr);
    metadataById.set(txtId, toBookInfo(txtId, entry));
  }
  return { state, metadataById };
}

/** Persists `content` back to this account's txt_metadata: reuses the
 * existing R2-backed path in place if there is one (an R2 PUT overwriting
 * it, no DB write at all -- the common case for any account that's already
 * ingested something), otherwise establishes a fresh path (a brand-new
 * account, or one migrating off the pre-R2-indirection inline-JSON format)
 * and points txt_metadata.content at it. Mirrors txt/owner.py's
 * _write_txt_metadata_content -- except a failed UPDATE here has no
 * rollback to fall back on (there's no transaction/rollback concept exposed
 * by this browser client, see db.ts): worst case, a newly-uploaded R2
 * object is left unpointed-to until the next successful write reestablishes
 * a pointer, the same class of harmless leftover this app already accepts
 * elsewhere (e.g. deleteTxt's orphaned part objects). Requires a
 * write-capable r2Client (see r2.ts's createR2Client) -- only ever true for
 * an admin session today (see docs/credentials.md). Returns the raw_path
 * this content actually ended up under (the given one, reused in place,
 * or the freshly-established one), so a caller updating a cached
 * RawMetadataState knows what to store for next time. */
async function persistMetadataContent(
  db: Client,
  userId: number,
  txtMetadataKey: Uint8Array,
  content: Record<string, TxtMetadataEntry>,
  rawPath: string | null,
  r2Client: AwsClient,
  r2Config: R2Config,
): Promise<string> {
  const body = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(JSON.stringify(content)), {
    compressed: true,
  });
  if (rawPath !== null) {
    await putObject(r2Client, r2Config, rawPath, body);
    return rawPath;
  }
  const newRawPath = base32.encode(randomBytes(c.RAW_PATH_LEN));
  await putObject(r2Client, r2Config, newRawPath, body);
  const pathBlob = await blob.encrypt(txtMetadataKey, new TextEncoder().encode(newRawPath));
  await db.execute({ sql: "UPDATE txt_metadata SET content = ? WHERE user_id = ?", args: [pathBlob, userId] });
  return newRawPath;
}

/** The curated metadata fields the admin Manage screen's Books section lets
 * an admin edit -- the same subset BookRow/Reader's summary already show,
 * not the full raw OPF/Calibre field list. */
export interface BookMetadataEdits {
  title?: string;
  author?: string;
  publisher?: string;
  subjects: string[];
  description?: string;
}

export interface SavedBookMetadata {
  info: BookInfo;
  /** The RawMetadataState after this write -- callers caching one (see
   * RawMetadataState's own doc comment) should replace their cached copy
   * with this rather than the one they passed in, since content (and
   * possibly rawPath, if this was the account's first-ever write)
   * changed. */
  state: RawMetadataState;
}

/** Admin Manage screen: overwrites one txt's curated metadata fields,
 * preserving its ingested `name` and any other OPF/Calibre field verbatim.
 * Throws if there's no existing txt_metadata entry for txtId at all.
 * Returns the updated entry's BookInfo directly (derived from the same
 * in-memory content this just wrote), plus the RawMetadataState to cache
 * for next time, rather than making the caller re-fetch+re-decrypt the
 * whole txt_metadata object a second time just to read back the one entry
 * it already has.
 *
 * `cachedState`, if given (including explicitly `null`, meaning "already
 * confirmed this account has no txt_metadata row"), is used as-is instead
 * of an `undefined` triggering a fresh fetch -- skipping the "Reading
 * current metadata" phase entirely on any edit after the first per
 * session. `onProgress`, if given, is called once per real network phase
 * that actually runs (there's no small-step-count concept worth a
 * "Step N of M" counter here, just the label itself) so a caller can show
 * something more specific than a bare spinner while this runs. */
export async function saveBookMetadata(
  db: Client,
  userId: number,
  umk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
  txtId: number,
  edits: BookMetadataEdits,
  onProgress?: (label: string) => void,
  cachedState?: RawMetadataState | null,
): Promise<SavedBookMetadata> {
  let state: RawMetadataState | null;
  if (cachedState !== undefined) {
    state = cachedState;
  } else {
    onProgress?.("Reading current metadata…");
    state = await loadRawMetadataState(db, userId, umk, r2Client, r2Config);
  }
  if (!state) {
    throw new Error(`no txt_metadata row for user_id=${userId}`);
  }
  const existing = state.content[String(txtId)];
  if (!existing) {
    throw new Error(`no txt_metadata entry for txt_id=${txtId}`);
  }
  const metadata: OpfMetadata = { ...(existing.metadata ?? {}) };
  const setOrDelete = (key: string, value: string | undefined) => {
    if (value) metadata[key] = value;
    else delete metadata[key];
  };
  setOrDelete("title", edits.title);
  setOrDelete("creator", edits.author);
  setOrDelete("publisher", edits.publisher);
  if (edits.subjects.length > 0) metadata.subject = edits.subjects;
  else delete metadata.subject;
  setOrDelete("description", edits.description);

  const nextEntry = { name: existing.name, metadata };
  const nextContent = { ...state.content, [String(txtId)]: nextEntry };
  onProgress?.("Uploading changes…");
  const nextRawPath = await persistMetadataContent(
    db,
    userId,
    state.txtMetadataKey,
    nextContent,
    state.rawPath,
    r2Client,
    r2Config,
  );
  return {
    info: toBookInfo(txtId, nextEntry),
    state: { txtMetadataKey: state.txtMetadataKey, content: nextContent, rawPath: nextRawPath },
  };
}

/** Admin Manage screen: removes one txt's entry entirely (its txt row is
 * being deleted). A no-op if there's no txt_metadata row, or no entry for
 * txtId, at all -- deleteTxt calls this unconditionally rather than
 * checking first. Returns the RawMetadataState to cache for next time
 * (null only if the account genuinely has no txt_metadata row at all) --
 * same cachedState/onProgress behavior as saveBookMetadata. */
export async function removeTxtMetadataEntry(
  db: Client,
  userId: number,
  umk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
  txtId: number,
  onProgress?: (label: string) => void,
  cachedState?: RawMetadataState | null,
): Promise<RawMetadataState | null> {
  let state: RawMetadataState | null;
  if (cachedState !== undefined) {
    state = cachedState;
  } else {
    onProgress?.("Reading current metadata…");
    state = await loadRawMetadataState(db, userId, umk, r2Client, r2Config);
  }
  if (!state || !(String(txtId) in state.content)) return state;
  const nextContent = { ...state.content };
  delete nextContent[String(txtId)];
  onProgress?.("Uploading changes…");
  const nextRawPath = await persistMetadataContent(
    db,
    userId,
    state.txtMetadataKey,
    nextContent,
    state.rawPath,
    r2Client,
    r2Config,
  );
  return { txtMetadataKey: state.txtMetadataKey, content: nextContent, rawPath: nextRawPath };
}

/** Sets (creating or overwriting) one txt_id's entry verbatim -- unlike
 * saveBookMetadata, which only edits an already-existing entry's curated
 * fields, this takes a full TxtMetadataEntry and doesn't require one to
 * already be there. Generic over any account's userId/umk, same as every
 * other function in this file -- what makes it usable for adminShares.ts's
 * grantShare to copy a txt's real metadata entry into a *recipient's* own
 * txt_metadata row (via the admin's escrowed access to that recipient's
 * umk, see adminUsers.ts's resolveUserUmk), not just the caller's own.
 * Throws if there's no txt_metadata row for userId at all -- every account
 * gets one provisioned at creation, so this should only ever happen for a
 * userId that doesn't actually exist. Same cachedState/onProgress
 * conventions as saveBookMetadata/removeTxtMetadataEntry. */
export async function upsertTxtMetadataEntry(
  db: Client,
  userId: number,
  umk: Uint8Array,
  r2Client: AwsClient,
  r2Config: R2Config,
  txtId: number,
  entry: TxtMetadataEntry,
  onProgress?: (label: string) => void,
  cachedState?: RawMetadataState | null,
): Promise<RawMetadataState> {
  let state: RawMetadataState | null;
  if (cachedState !== undefined) {
    state = cachedState;
  } else {
    onProgress?.("Reading current metadata…");
    state = await loadRawMetadataState(db, userId, umk, r2Client, r2Config);
  }
  if (!state) {
    throw new Error(`no txt_metadata row for user_id=${userId}`);
  }
  const nextContent = { ...state.content, [String(txtId)]: entry };
  onProgress?.("Uploading changes…");
  const nextRawPath = await persistMetadataContent(
    db,
    userId,
    state.txtMetadataKey,
    nextContent,
    state.rawPath,
    r2Client,
    r2Config,
  );
  return { txtMetadataKey: state.txtMetadataKey, content: nextContent, rawPath: nextRawPath };
}
