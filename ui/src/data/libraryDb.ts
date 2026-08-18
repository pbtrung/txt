// Reads the txt table's catalog (docs/data_model.md §3.1: a flat
// {name, title, authors, subjects, publisher} object, brotli-compressed
// JSON) into plain LibraryBook records for the Library screen's
// search/browse-by-author/subject/publisher.
import { decodeCatalog } from "./catalog";
import type { DatabaseMutation } from "./databaseStore";
import type { SqliteDatabase } from "./sqlite";

export interface LibraryBook {
  txtId: number;
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
  lastAccessed: number;
  bookmarkCount: number;
  lastBookmarked: number | null;
  latestBookmarkCfi: string | null;
}

async function toBook(row: unknown[]): Promise<LibraryBook> {
  const [
    txtId,
    catalogBlob,
    lastAccessed,
    bookmarkCount,
    lastBookmarked,
    latestBookmarkCfi,
  ] = row;
  const catalog = await decodeCatalog(catalogBlob as Uint8Array);
  return {
    txtId: txtId as number,
    title: catalog.title,
    authors: catalog.authors,
    subjects: catalog.subjects,
    publisher: catalog.publisher,
    lastAccessed: lastAccessed as number,
    bookmarkCount: bookmarkCount as number,
    lastBookmarked: lastBookmarked as number | null,
    latestBookmarkCfi: latestBookmarkCfi as string | null,
  };
}

export async function loadLibraryBooks(db: SqliteDatabase): Promise<LibraryBook[]> {
  const rows = db.query(
    "SELECT t.id, t.catalog, t.last_accessed, COUNT(b.id), MAX(b.created_at), " +
      "(SELECT latest.cfi FROM txt_bookmarks latest WHERE latest.txt_id = t.id " +
      "ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) " +
      "FROM txt t LEFT JOIN txt_bookmarks b ON b.txt_id = t.id " +
      "GROUP BY t.id ORDER BY t.id",
  );
  return Promise.all(rows.map(toBook));
}

export function clearLastAccessMutation(txtId: number): DatabaseMutation {
  return {
    description: "clear last access",
    apply: (db) => db.execute("UPDATE txt SET last_accessed = 0 WHERE id = ?", [txtId]),
  };
}

export function clearBookmarksMutation(txtId: number): DatabaseMutation {
  return {
    description: "clear bookmarks",
    apply: (db) => db.execute("DELETE FROM txt_bookmarks WHERE txt_id = ?", [txtId]),
  };
}
