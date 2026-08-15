// Looks up one txt row and fetches+decrypts its content object
// (docs/data_model.md §1: {db_prefix}/{txt_prefix}/{path}), keyed by that
// row's own txt_key -- unrelated to db_master_key, so leaking one
// document's key exposes nothing about any other document or the database
// file itself. Metadata comes from the txt row's own catalog for now
// (title/authors/subjects/publisher only) -- richer detail is planned to
// come from parsing the EPUB's own internal OPF once it's downloaded.
import { decrypt } from "../crypto/cryptoBlob";
import { brotliDecompress } from "../crypto/brotli";
import { toBase32Crockford } from "../util/base32Crockford";
import type { R2Client } from "./r2";
import type { SqliteDatabase } from "./sqlite";

export interface ReaderDocument {
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
  epubBytes: Uint8Array;
}

interface Catalog {
  name: string;
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
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
  return {
    title: catalog.title,
    authors: catalog.authors,
    subjects: catalog.subjects,
    publisher: catalog.publisher,
    epubBytes,
  };
}
