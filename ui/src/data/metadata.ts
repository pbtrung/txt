// Decrypts+parses txt_metadata.content and normalizes each entry's OPF
// metadata (txt/opf.py's shape: dc:* local tag names, Calibre `meta
// name/content` pairs, repeated tags collapsed into a list -- see
// docs/data_model.md's txt_metadata) into a tolerant BookInfo, mirroring
// txt/download.py's _txt_names but keeping the full metadata, not just name.

import type { Client } from "@libsql/core/api";

import * as blob from "../crypto/blob";
import { requireBlobBytes } from "./db";

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
