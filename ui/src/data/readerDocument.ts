// Looks up one txt row and fetches+decrypts its content object
// (docs/data_model.md §1: {db_prefix}/{txt_prefix}/{path}), keyed by that
// row's own txt_key -- unrelated to db_master_key, so leaking one
// document's key exposes nothing about any other document or the database
// file itself. Title comes from the txt row's own catalog (cheap, already
// fetched); everything else the Info panel shows comes from parsing the
// EPUB's own internal package document once its bytes are in hand, since
// catalog only keeps a fixed subset (docs/data_model.md §3.1).
import { decrypt } from "../crypto/cryptoBlob";
import { toBase32Crockford } from "../util/base32Crockford";
import { decodeCatalog } from "./catalog";
import { extraMetadataFields, parseEpubOpf, type MetadataField } from "./epubOpf";
import { fieldStrings } from "./opfMetadata";
import type { SqliteDatabase } from "./sqlite";

interface ContentStore {
  getContent(key: string): Promise<Uint8Array | null>;
}

export interface ReaderLoadProgress {
  label: string;
  step: number;
  total: number;
}

export const READER_LOAD_TOTAL_STEPS = 5;

export interface ReaderDocument {
  txtId: number;
  lastCfi: string | null;
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
  extraMetadata: MetadataField[];
  epubBytes: Uint8Array;
}

function contentKey(dbPrefix: string, txtPrefix: Uint8Array, path: Uint8Array): string {
  return `${dbPrefix}/${toBase32Crockford(txtPrefix)}/${toBase32Crockford(path)}`;
}

export async function loadReaderDocument(
  db: SqliteDatabase,
  storage: ContentStore,
  dbPrefix: string,
  txtId: number,
  onProgress?: (progress: ReaderLoadProgress) => void,
): Promise<ReaderDocument | null> {
  reportProgress(onProgress, "Reading book details", 1);
  const rows = db.query(
    "SELECT txt_key, txt_prefix, path, catalog, last_cfi FROM txt WHERE id = ?",
    [txtId],
  );
  if (rows.length === 0) return null;
  const [txtKey, txtPrefix, path, catalogBlob, lastCfi] = rows[0] as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    string | null,
  ];

  reportProgress(onProgress, "Downloading text", 2);
  const encrypted = await storage.getContent(contentKey(dbPrefix, txtPrefix, path));
  if (!encrypted) return null;

  reportProgress(onProgress, "Decrypting text", 3);
  const epubBytes = await decrypt(encrypted, txtKey);
  reportProgress(onProgress, "Reading book metadata", 4);
  const catalog = await decodeCatalog(catalogBlob);
  const opf = await parseEpubOpf(epubBytes);
  const publishers = fieldStrings(opf.metadata.publisher);
  return {
    txtId,
    lastCfi,
    title: catalog.title,
    authors: fieldStrings(opf.metadata.creator),
    subjects: fieldStrings(opf.metadata.subject),
    publisher: publishers[0] ?? null,
    extraMetadata: extraMetadataFields(opf),
    epubBytes,
  };
}

function reportProgress(
  onProgress: ((progress: ReaderLoadProgress) => void) | undefined,
  label: string,
  step: number,
): void {
  onProgress?.({ label, step, total: READER_LOAD_TOTAL_STEPS });
}
