// Looks up one txt row and fetches+decrypts its content object
// (docs/data_model.md §1: {db_prefix}/{txt_prefix}/{path}), keyed by that
// row's own txt_key -- unrelated to db_master_key, so leaking one
// document's key exposes nothing about any other document or the database
// file itself. Title comes from the txt row's own catalog (cheap, already
// fetched); everything else the Info panel shows comes from parsing the
// EPUB's own internal package document once its bytes are in hand, since
// catalog only keeps a fixed subset (docs/data_model.md §3.1).
import { decrypt } from "../crypto/cryptoBlob";
import { brotliDecompress } from "../crypto/brotli";
import { toBase32Crockford } from "../util/base32Crockford";
import { extraMetadataFields, parseEpubOpf, type MetadataField } from "./epubOpf";
import { fieldStrings } from "./opfSidecar";
import type { R2Client } from "./r2";
import type { SqliteDatabase } from "./sqlite";

export type { MetadataField };

export interface ReaderDocument {
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
  extraMetadata: MetadataField[];
  epubBytes: Uint8Array;
}

interface Catalog {
  name: string;
  title: string;
}

function contentKey(dbPrefix: string, txtPrefix: Uint8Array, path: Uint8Array): string {
  return `${dbPrefix}/${toBase32Crockford(txtPrefix)}/${toBase32Crockford(path)}`;
}

export async function loadReaderDocument(
  db: SqliteDatabase,
  r2: R2Client,
  dbPrefix: string,
  txtId: number,
): Promise<ReaderDocument | null> {
  const rows = db.query(
    "SELECT txt_key, txt_prefix, path, catalog FROM txt WHERE id = ?",
    [txtId],
  );
  if (rows.length === 0) return null;
  const [txtKey, txtPrefix, path, catalogBlob] = rows[0] as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];

  const encrypted = await r2.getObject(contentKey(dbPrefix, txtPrefix, path));
  if (!encrypted) return null;

  const epubBytes = await decrypt(encrypted, txtKey);
  const json = new TextDecoder().decode(await brotliDecompress(catalogBlob));
  const catalog = JSON.parse(json) as Catalog;
  const opf = await parseEpubOpf(epubBytes);
  const publishers = fieldStrings(opf.metadata.publisher);
  return {
    title: catalog.title,
    authors: fieldStrings(opf.metadata.creator),
    subjects: fieldStrings(opf.metadata.subject),
    publisher: publishers[0] ?? null,
    extraMetadata: extraMetadataFields(opf),
    epubBytes,
  };
}
