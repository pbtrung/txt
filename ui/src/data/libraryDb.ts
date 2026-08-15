// Reads the txt table's metadata (via opfSidecar.ts) into plain
// LibraryBook records for the Library screen's search/browse-by-
// author/subject/publisher.
import { fieldStrings, parseOpfSidecar, titleOf } from "./opfSidecar";
import type { SqliteDatabase } from "./sqlite";

export interface LibraryBook {
  txtId: number;
  title: string;
  sortKey: string | null;
  authors: string[];
  subjects: string[];
  publisher: string | null;
}

async function toBook(txtId: number, metadataBlob: Uint8Array): Promise<LibraryBook> {
  const sidecar = await parseOpfSidecar(metadataBlob);
  const opf = sidecar.metadata ?? {};
  return {
    txtId,
    title: titleOf(sidecar),
    sortKey: null,
    authors: fieldStrings(opf.creator),
    subjects: fieldStrings(opf.subject),
    publisher: fieldStrings(opf.publisher)[0] ?? null,
  };
}

export async function loadLibraryBooks(db: SqliteDatabase): Promise<LibraryBook[]> {
  const rows = db.query("SELECT id, metadata FROM txt ORDER BY id");
  return Promise.all(
    rows.map(([id, metadata]) => toBook(id as number, metadata as Uint8Array)),
  );
}
