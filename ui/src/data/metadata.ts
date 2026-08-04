// Presentational shaping of one txt's OPF/Calibre metadata (txt/opf.py's
// shape: dc:* local tag names, Calibre `meta name/content` pairs, repeated
// tags collapsed into a list) into a tolerant BookInfo -- mirrors
// txt/download.py's _txt_names but keeps the full metadata, not just name.
//
// docs/data_model.md's txtMetadata.content decrypts (under that document's
// own txtKey -- see library.ts, which resolves that key and calls
// parseMetadataContent below) to a single JSON object: {"name": "original
// filename", "metadata": {...opf sidecar fields, when present}}. name and
// metadata used to be two separate SQL columns (one always-present TEXT,
// one nullable BLOB); now they're both fields of the one decrypted payload.

import * as blob from "../crypto/blob";
import { base64ToBytes } from "../crypto/bytes";
import { requireObject, requireString } from "./jsonObject";

export interface MetadataField {
  key: string;
  values: string[];
}

export interface BookInfo {
  txtId: string;
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
export type OpfMetadata = Record<string, OpfValue>;

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
const HIDDEN_METADATA_KEYS = new Set([
  "calibre:rating",
  "calibre:title_sort",
  "description",
  "subject",
]);

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
export function formatOpfDate(raw: string): string {
  const match = OPF_DATE_RE.exec(raw);
  if (!match) return raw;
  const [, year, month, day, hour, minute, second] = match;
  const hasTime = hour !== undefined;
  const isMidnight =
    hasTime && hour === "00" && minute === "00" && second === "00";
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour ?? 0),
      Number(minute ?? 0),
    ),
  );
  const dateText = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  if (!hasTime || isMidnight) return dateText;
  const timeText = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return `${dateText}, ${timeText}`;
}

function toRawMetadata(md: OpfMetadata): MetadataField[] {
  return Object.entries(md)
    .filter(([key]) => !HIDDEN_METADATA_KEYS.has(key))
    .map(([key, value]) => {
      const values = textsOf(value);
      return {
        key: RENAMED_METADATA_KEYS[key] ?? key,
        values: DATE_METADATA_KEYS.has(key)
          ? values.map(formatOpfDate)
          : values,
      };
    })
    .filter((field) => field.values.length > 0);
}

export interface TxtMetadataContent {
  name: string;
  metadata: OpfMetadata;
}

export function toBookInfo(
  txtId: string,
  content: TxtMetadataContent,
): BookInfo {
  const { name, metadata } = content;
  return {
    txtId,
    name,
    title: textOf(metadata.title) ?? name,
    author: textOf(metadata.creator),
    subjects: textsOf(metadata.subject),
    publisher: textOf(metadata.publisher),
    description: textOf(metadata.description),
    series: textOf(metadata["calibre:series"]),
    seriesIndex: textOf(metadata["calibre:series_index"]),
    rawMetadata: toRawMetadata(metadata),
  };
}

/** Decrypts a txtMetadata row's own `content` blob (base64) under this
 * document's already-resolved docKey (library.ts) and decodes it into
 * {name, metadata} -- docs/data_model.md's txtMetadata entity: a single
 * encrypted, brotli-compressed JSON blob, wrapped directly under txtKey (no
 * intermediate key, unlike keyStore/credStore/txtAccess/txtBookmarks). */
export async function parseMetadataContent(
  docKey: Uint8Array,
  contentBase64: string,
): Promise<TxtMetadataContent> {
  const json = await blob.decrypt(docKey, base64ToBytes(contentBase64), true);
  const parsed = requireObject(
    JSON.parse(new TextDecoder().decode(json)),
    "txtMetadata.content must decode to a JSON object",
  );
  const metadata = parsed.metadata;
  return {
    name: requireString(parsed, "name"),
    metadata: (typeof metadata === "object" && metadata !== null
      ? metadata
      : {}) as OpfMetadata,
  };
}
