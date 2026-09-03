// Fetches and decrypts one document's EPUB bytes (docs/storage_layout.md
// §"Owner document objects": {db_prefix}/documents/{path}), keyed by that
// document's own content_key -- unrelated to any other document's key, so
// leaking one document's key exposes nothing about any other. Title comes
// from the library's already-decrypted catalog entry (LibraryStore);
// everything else the Info panel shows comes from parsing the EPUB's own
// internal package document once its bytes are in hand, since the catalog
// only keeps a fixed subset (docs/data_model.md §2.1).
import { decrypt } from "../crypto/cryptoBlob";
import { extraMetadataFields, parseEpubOpf, type MetadataField } from "./epubOpf";
import type { LibraryStore } from "./libraryStore";
import { fieldStrings } from "./opfMetadata";
import type { R2Session } from "./r2Session";

export interface ReaderLoadProgress {
  label: string;
  step: number;
  total: number;
}

export const READER_LOAD_TOTAL_STEPS = 4;

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

export async function loadReaderDocument(
  library: LibraryStore,
  storage: R2Session,
  dbPrefix: string,
  txtId: number,
  onProgress?: (progress: ReaderLoadProgress) => void,
): Promise<ReaderDocument | null> {
  reportProgress(onProgress, "Reading book details", 1);
  const document = await library.getReaderDocument(txtId);
  if (!document) return null;

  reportProgress(onProgress, "Downloading text", 2);
  const encrypted = await storage.getDocument(`${dbPrefix}/documents/${document.path}`);
  if (!encrypted) return null;

  reportProgress(onProgress, "Decrypting text", 3);
  const epubBytes = await decrypt(encrypted, document.contentKey);
  reportProgress(onProgress, "Reading book metadata", 4);
  const opf = await parseEpubOpf(epubBytes);
  const publishers = fieldStrings(opf.metadata.publisher);
  return {
    txtId,
    lastCfi: document.lastCfi,
    title: document.title,
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
