// Reads the txt table's catalog (docs/data_model.md §2.1: a flat
// {name, title, authors, subjects, publisher} object, brotli-compressed
// JSON) into plain LibraryBook records for the Library screen's
// search/browse-by-author/subject/publisher.
import { decodeCatalog, type Catalog } from "./catalog";
import type { DatabaseMutation } from "./databaseStore";
import type { SqliteDatabase } from "./sqlite";

// txt.catalog is written once at ingest time and never edited afterward by
// anything the browser can trigger, and txt.id is AUTOINCREMENT (SQLite
// never reuses an id, and this app has no client-side delete-book feature),
// so a decoded catalog can be cached by txtId for the lifetime of a session
// with no invalidation logic at all -- a book only ever needs decoding once,
// no matter how many times library.reload() re-runs this query.
export type CatalogCache = Map<number, Catalog>;

export interface LibraryBookmark {
  cfi: string;
  pageNumber: number | null;
  createdAt: number;
}

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
  bookmarks: LibraryBookmark[];
}

async function catalogFor(txtId: number, blob: Uint8Array, cache: CatalogCache) {
  const cached = cache.get(txtId);
  if (cached) return cached;
  const catalog = await decodeCatalog(blob);
  cache.set(txtId, catalog);
  return catalog;
}

async function toBook(
  row: unknown[],
  bookmarks: LibraryBookmark[],
  cache: CatalogCache,
): Promise<LibraryBook> {
  const [
    txtId,
    catalogBlob,
    lastAccessed,
    bookmarkCount,
    lastBookmarked,
    latestBookmarkCfi,
  ] = row;
  const catalog = await catalogFor(txtId as number, catalogBlob as Uint8Array, cache);
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
    bookmarks,
  };
}

export async function loadLibraryBooks(
  db: SqliteDatabase,
  cache: CatalogCache = new Map(),
): Promise<LibraryBook[]> {
  const bookmarks = bookmarksByBook(db);
  const rows = db.query(
    "SELECT t.id, t.catalog, t.last_accessed, COUNT(b.id), MAX(b.created_at), " +
      "(SELECT latest.cfi FROM txt_bookmarks latest WHERE latest.txt_id = t.id " +
      "ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) " +
      "FROM txt t LEFT JOIN txt_bookmarks b ON b.txt_id = t.id " +
      "GROUP BY t.id ORDER BY t.id",
  );
  return Promise.all(
    rows.map((row) => toBook(row, bookmarks.get(row[0] as number) ?? [], cache)),
  );
}

function bookmarksByBook(db: SqliteDatabase): Map<number, LibraryBookmark[]> {
  const result = new Map<number, LibraryBookmark[]>();
  const rows = db.query(
    "SELECT txt_id, cfi, page_number, created_at FROM txt_bookmarks " +
      "ORDER BY created_at DESC, id DESC",
  );
  for (const [txtId, cfi, pageNumber, createdAt] of rows) {
    const bookmark: LibraryBookmark = {
      cfi: cfi as string,
      pageNumber: pageNumber as number | null,
      createdAt: createdAt as number,
    };
    const bookBookmarks = result.get(txtId as number);
    if (bookBookmarks) bookBookmarks.push(bookmark);
    else result.set(txtId as number, [bookmark]);
  }
  return result;
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
