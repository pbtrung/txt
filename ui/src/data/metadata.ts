// Decrypts+parses txt_metadata.content and normalizes each entry's OPF
// metadata (txt/opf.py's shape: dc:* local tag names, Calibre `meta
// name/content` pairs, repeated tags collapsed into a list -- see
// docs/data_model.md's txt_metadata) into a tolerant BookInfo, mirroring
// txt/download.py's _txt_names but keeping the full metadata, not just name.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { requireBlobBytes } from "./db";

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
interface TxtMetadataEntry {
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

// calibre:timestamp (when the book was added to the Calibre library) reads
// as an internal field name; shown under its plainer meaning instead.
const RENAMED_METADATA_KEYS: Record<string, string> = { "calibre:timestamp": "timestamp" };

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

/** All of this account's book metadata, keyed by txt_id. Empty if the account has no txt yet. */
export async function loadTxtMetadata(db: Client, userId: number, umk: Uint8Array): Promise<Map<number, BookInfo>> {
  const result = await db.execute({
    sql: "SELECT txt_metadata_key, content FROM txt_metadata WHERE user_id = ?",
    args: [userId],
  });
  const row = result.rows[0];
  if (!row || row.content === null) {
    return new Map();
  }
  const txtMetadataKey = await blob.decrypt(
    umk,
    requireBlobBytes(row.txt_metadata_key, "txt_metadata.txt_metadata_key"),
  );
  const contentBytes = await blob.decrypt(txtMetadataKey, requireBlobBytes(row.content, "txt_metadata.content"), true);
  const content = JSON.parse(new TextDecoder().decode(contentBytes)) as Record<string, TxtMetadataEntry>;

  const byId = new Map<number, BookInfo>();
  for (const [txtIdStr, entry] of Object.entries(content)) {
    const txtId = Number(txtIdStr);
    byId.set(txtId, toBookInfo(txtId, entry));
  }
  return byId;
}

/** One book's metadata -- for the Reader, which only needs a single txt_id. */
export async function getBookInfo(
  db: Client,
  userId: number,
  umk: Uint8Array,
  txtId: number,
): Promise<BookInfo | null> {
  const byId = await loadTxtMetadata(db, userId, umk);
  return byId.get(txtId) ?? null;
}
