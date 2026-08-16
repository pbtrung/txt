// Reads the txt table's catalog (docs/data_model.md §3.1: a flat
// {name, title, authors, subjects, publisher} object, brotli-compressed
// JSON) into plain LibraryBook records for the Library screen's
// search/browse-by-author/subject/publisher.
import { decodeCatalog } from "./catalog";
import type { SqliteDatabase } from "./sqlite";

export interface LibraryBook {
  txtId: number;
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
}

async function toBook(txtId: number, catalogBlob: Uint8Array): Promise<LibraryBook> {
  const catalog = await decodeCatalog(catalogBlob);
  return {
    txtId,
    title: catalog.title,
    authors: catalog.authors,
    subjects: catalog.subjects,
    publisher: catalog.publisher,
  };
}

export async function loadLibraryBooks(db: SqliteDatabase): Promise<LibraryBook[]> {
  const rows = db.query("SELECT id, catalog FROM txt ORDER BY id");
  return Promise.all(
    rows.map(([id, catalog]) => toBook(id as number, catalog as Uint8Array)),
  );
}
