// Replaces the old whole-file SQLCipher database (databaseStore.ts,
// libraryDb.ts, schema.ts, sqlite.ts): the owner's library now lives in
// D1 behind /v1/*, fetched and decrypted client-side, with no local
// database file at all (docs/data_model.md §3). This is the one place
// that holds `umk` for as long as the session is unlocked, and the one
// place every document/bookmark row-level blob gets unwrapped or
// re-wrapped -- readerDocument.ts, readingState.ts, and shares.ts all go
// through it rather than touching `umk` themselves.
import { decrypt, decryptJson, encrypt, encryptJson } from "../crypto/cryptoBlob";
import { fromBase64 } from "../util/base64";
import { errorMessage } from "../util/errorMessage";
import { objectRecord, stringArrayField, stringField } from "../util/validation";
import {
  AccessVersionConflictError,
  type ApiClient,
  type BookmarkSummaryRow,
  type DocumentRow,
} from "./apiClient";
import type { OwnerSigningIdentity } from "./ownerProof";
import type { R2Session } from "./r2Session";

const MAX_CONFLICT_ATTEMPTS = 3;
const PREVIEW_BYTES = 100;

export interface LibraryBookmark {
  id: number;
  cfi: string;
  pageNumber: number | null;
  createdAt: number;
}

export interface LibraryBook {
  txtId: number; // documents.id
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
  lastAccessed: number;
  bookmarkCount: number;
  lastBookmarked: number | null;
  latestBookmarkCfi: string | null;
  // Only the single latest bookmark (GET /v1/bookmarks/summary) -- never
  // the full per-book history, which the Reader screen fetches on its own
  // via listBookmarks() when a specific book is open.
  bookmarks: LibraryBookmark[];
}

export interface BookmarkRecord {
  id: number;
  cfi: string;
  pageNumber: number | null;
  preview: string;
  createdAt: number;
}

export interface LibraryStoreStatus {
  pending: boolean;
  error: string | null;
}

interface CatalogEntry {
  title: string;
  authors: string[];
  subjects: string[];
  publisher: string | null;
}

interface DocumentSecret {
  accessKey: Uint8Array;
  accessVersion: number;
  lastAccessed: number;
  lastCfi: string | null;
}

export class LibraryStore {
  private books: LibraryBook[] = [];
  private secrets = new Map<number, DocumentSecret>();
  private status: LibraryStoreStatus = { pending: false, error: null };
  private listeners = new Set<() => void>();

  private constructor(
    private readonly api: ApiClient,
    private readonly storage: R2Session,
    private readonly signing: OwnerSigningIdentity,
    private readonly dbPrefix: string,
    private readonly umk: Uint8Array,
  ) {}

  static async open(
    api: ApiClient,
    storage: R2Session,
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    umk: Uint8Array,
  ): Promise<LibraryStore> {
    const store = new LibraryStore(api, storage, signing, dbPrefix, umk);
    await store.reload();
    return store;
  }

  snapshot(): LibraryBook[] {
    return this.books;
  }

  statusSnapshot(): LibraryStoreStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reload(): Promise<void> {
    this.emit({ pending: true, error: null });
    try {
      const [documents, catalogRow, summaries] = await Promise.all([
        this.api.fetchDocuments(),
        this.api.fetchCatalog(),
        this.api.fetchBookmarksSummary(),
      ]);
      const catalogEntries = catalogRow
        ? await this.loadCatalogEntries(catalogRow.keyWrapped, catalogRow.catalogBlob)
        : new Map<number, CatalogEntry>();
      const summaryByDocument = new Map(summaries.map((row) => [row.documentId, row]));
      const { secrets, books } = await this.buildBooks(
        documents,
        catalogEntries,
        summaryByDocument,
      );
      this.secrets = secrets;
      this.books = books;
      this.emit({ pending: false, error: null });
    } catch (error) {
      this.emit({ pending: false, error: errorMessage(error) });
      throw error;
    }
  }

  // One malformed or partially-migrated document row must not hide every
  // other valid book in the library -- unwrap each independently and skip
  // (rather than abort the whole reload for) any that fails.
  private async buildBooks(
    documents: DocumentRow[],
    catalogEntries: Map<number, CatalogEntry>,
    summaryByDocument: Map<number, BookmarkSummaryRow>,
  ): Promise<{ secrets: Map<number, DocumentSecret>; books: LibraryBook[] }> {
    const results = await Promise.all(
      documents.map((document) =>
        this.tryBuildBook(document, catalogEntries, summaryByDocument),
      ),
    );
    const secrets = new Map<number, DocumentSecret>();
    const books: LibraryBook[] = [];
    for (const result of results) {
      if (!result) continue;
      secrets.set(result.txtId, result.secret);
      books.push(result.book);
    }
    return { secrets, books };
  }

  private async tryBuildBook(
    document: DocumentRow,
    catalogEntries: Map<number, CatalogEntry>,
    summaryByDocument: Map<number, BookmarkSummaryRow>,
  ): Promise<{ txtId: number; secret: DocumentSecret; book: LibraryBook } | null> {
    try {
      const secret = await this.unwrapDocumentSecret(document);
      const catalog = catalogEntries.get(document.id);
      const summary = summaryByDocument.get(document.id);
      const bookmarks = summary ? [await this.unwrapBookmarkSummary(summary)] : [];
      const book = this.toLibraryBook(document.id, catalog, secret, summary, bookmarks);
      return { txtId: document.id, secret, book };
    } catch (error) {
      console.error(
        `LibraryStore: skipping document ${document.id}: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  private toLibraryBook(
    txtId: number,
    catalog: CatalogEntry | undefined,
    secret: DocumentSecret,
    summary: BookmarkSummaryRow | undefined,
    bookmarks: LibraryBookmark[],
  ): LibraryBook {
    return {
      txtId,
      title: catalog?.title ?? "Untitled",
      authors: catalog?.authors ?? [],
      subjects: catalog?.subjects ?? [],
      publisher: catalog?.publisher ?? null,
      lastAccessed: secret.lastAccessed,
      bookmarkCount: summary?.count ?? 0,
      lastBookmarked: summary?.createdAt ?? null,
      latestBookmarkCfi: bookmarks[0]?.cfi ?? null,
      bookmarks,
    };
  }

  private async unwrapDocumentSecret(document: DocumentRow): Promise<DocumentSecret> {
    const accessKey = await decrypt(document.accessKeyWrapped, this.umk);
    const access = parseAccessPayload(
      await decryptJson<unknown>(document.accessBlob, accessKey),
    );
    return {
      accessKey,
      accessVersion: document.accessVersion,
      lastAccessed: access.last_accessed,
      lastCfi: access.last_cfi,
    };
  }

  private async unwrapBookmarkSummary(
    summary: BookmarkSummaryRow,
  ): Promise<LibraryBookmark> {
    const rowKey = await decrypt(summary.keyWrapped, this.umk);
    const payload = parseBookmarkPayload(
      await decryptJson<unknown>(summary.bookmarkBlob, rowKey),
    );
    return {
      id: summary.id,
      cfi: payload.cfi,
      pageNumber: payload.page_number,
      createdAt: summary.createdAt,
    };
  }

  private async loadCatalogEntries(
    keyWrapped: Uint8Array,
    catalogBlob: Uint8Array,
  ): Promise<Map<number, CatalogEntry>> {
    const rowKey = await decrypt(keyWrapped, this.umk);
    const pointer = parseCatalogPointer(
      await decryptJson<unknown>(catalogBlob, rowKey),
    );
    const objectBytes = await this.storage.getCatalogObject(
      `${this.dbPrefix}/catalog/${pointer.catalog_path}`,
    );
    if (!objectBytes) return new Map();
    const entries = await decryptJson<unknown>(
      objectBytes,
      fromBase64(pointer.catalog_key),
    );
    return new Map(parseCatalogEntries(entries));
  }

  /** Everything readerDocument.ts needs to open one document: its content
   * key + R2 path, last saved CFI, and title (from the catalog this store
   * already decrypted) -- never the document's access key, which stays
   * private to this store's own updateReadingPosition()/clearLastAccessed().
   * The content key/pointer aren't unwrapped until this is actually
   * called (docs/data_model.md §3) -- fetched fresh from
   * GET /v1/documents/:id/content rather than cached from reload(), so a
   * book nobody opens never costs a content_key_id key_store row. */
  async getReaderDocument(
    txtId: number,
  ): Promise<
    | { contentKey: Uint8Array; path: string; lastCfi: string | null; title: string }
    | undefined
  > {
    const secret = this.secrets.get(txtId);
    if (!secret) return undefined;
    const content = await this.api.fetchDocumentContent(txtId);
    if (!content) return undefined;
    const contentRowKey = await decrypt(content.contentKeyWrapped, this.umk);
    const pointer = parseContentPointer(
      await decryptJson<unknown>(content.contentBlob, contentRowKey),
    );
    const title = this.books.find((book) => book.txtId === txtId)?.title ?? "Untitled";
    return {
      contentKey: fromBase64(pointer.content_key),
      path: pointer.path,
      lastCfi: secret.lastCfi,
      title,
    };
  }

  async clearLastAccessed(txtId: number): Promise<void> {
    await this.updateAccess(txtId, (current) => ({
      lastAccessed: 0,
      lastCfi: current.lastCfi,
    }));
  }

  async updateReadingPosition(
    txtId: number,
    cfi: string | null,
    lastAccessed: number | null,
  ): Promise<void> {
    await this.updateAccess(txtId, (current) => ({
      lastAccessed: lastAccessed ?? current.lastAccessed,
      lastCfi: cfi ?? current.lastCfi,
    }));
  }

  private async updateAccess(
    txtId: number,
    apply: (current: { lastAccessed: number; lastCfi: string | null }) => {
      lastAccessed: number;
      lastCfi: string | null;
    },
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_CONFLICT_ATTEMPTS; attempt += 1) {
      const secret = this.requireSecret(txtId);
      const next = apply({
        lastAccessed: secret.lastAccessed,
        lastCfi: secret.lastCfi,
      });
      const blob = await encryptJson(
        { last_accessed: next.lastAccessed, last_cfi: next.lastCfi },
        secret.accessKey,
      );
      try {
        const accessVersion = await this.api.updateDocumentAccess(
          txtId,
          blob,
          secret.accessVersion,
          this.signing,
          this.dbPrefix,
        );
        this.secrets.set(txtId, { ...secret, accessVersion, ...next });
        this.patchBook(txtId, (book) => ({ ...book, lastAccessed: next.lastAccessed }));
        return;
      } catch (error) {
        if (
          error instanceof AccessVersionConflictError &&
          attempt < MAX_CONFLICT_ATTEMPTS
        ) {
          await this.refreshAccessSecret(txtId);
          continue;
        }
        throw error;
      }
    }
  }

  private async refreshAccessSecret(txtId: number): Promise<void> {
    const secret = this.requireSecret(txtId);
    const documents = await this.api.fetchDocuments();
    const document = documents.find((row) => row.id === txtId);
    if (!document) throw new Error("document not found");
    const access = parseAccessPayload(
      await decryptJson<unknown>(document.accessBlob, secret.accessKey),
    );
    this.secrets.set(txtId, {
      ...secret,
      accessVersion: document.accessVersion,
      lastAccessed: access.last_accessed,
      lastCfi: access.last_cfi,
    });
  }

  async listBookmarks(txtId: number): Promise<BookmarkRecord[]> {
    const rows = await this.api.fetchBookmarks(txtId);
    return Promise.all(
      rows.map(async (row) => {
        const rowKey = await decrypt(row.keyWrapped, this.umk);
        const payload = parseBookmarkPayload(
          await decryptJson<unknown>(row.bookmarkBlob, rowKey),
        );
        return {
          id: row.id,
          cfi: payload.cfi,
          pageNumber: payload.page_number,
          preview: payload.preview,
          createdAt: row.createdAt,
        };
      }),
    );
  }

  async saveBookmark(
    txtId: number,
    cfi: string,
    pageNumber: number,
    preview: string,
  ): Promise<void> {
    const bookmarkKey = crypto.getRandomValues(new Uint8Array(128));
    const keyWrapped = await encrypt(bookmarkKey, this.umk);
    const blob = await encryptJson(
      {
        cfi,
        page_number: validPageNumber(pageNumber),
        preview: truncateUtf8(normalizePreview(preview), PREVIEW_BYTES),
      },
      bookmarkKey,
    );
    await this.api.createBookmark(txtId, keyWrapped, blob, this.signing, this.dbPrefix);
    await this.reloadBookmarksSummary();
  }

  async deleteBookmark(id: number): Promise<void> {
    await this.api.deleteBookmark(id, this.signing, this.dbPrefix);
    await this.reloadBookmarksSummary();
  }

  private async reloadBookmarksSummary(): Promise<void> {
    const summaries = await this.api.fetchBookmarksSummary();
    const summaryByDocument = new Map(summaries.map((row) => [row.documentId, row]));
    this.books = await Promise.all(
      this.books.map(async (book) => {
        const summary = summaryByDocument.get(book.txtId);
        const bookmarks = summary ? [await this.unwrapBookmarkSummary(summary)] : [];
        return {
          ...book,
          bookmarkCount: summary?.count ?? 0,
          lastBookmarked: summary?.createdAt ?? null,
          latestBookmarkCfi: bookmarks[0]?.cfi ?? null,
          bookmarks,
        };
      }),
    );
    this.emit(this.status);
  }

  private requireSecret(txtId: number): DocumentSecret {
    const secret = this.secrets.get(txtId);
    if (!secret) throw new Error("document not found");
    return secret;
  }

  private patchBook(txtId: number, apply: (book: LibraryBook) => LibraryBook): void {
    this.books = this.books.map((book) => (book.txtId === txtId ? apply(book) : book));
    this.emit(this.status);
  }

  private emit(status: LibraryStoreStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}

function validPageNumber(pageNumber: number): number | null {
  return Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : null;
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (used + size > maximumBytes) break;
    result += character;
    used += size;
  }
  return result;
}

interface ContentPointer {
  content_key: string;
  path: string;
}

function parseContentPointer(value: unknown): ContentPointer {
  const data = objectRecord(value, "content pointer");
  return {
    content_key: stringField(data, "content_key", "content pointer"),
    path: stringField(data, "path", "content pointer"),
  };
}

interface AccessPayload {
  last_accessed: number;
  last_cfi: string | null;
}

function parseAccessPayload(value: unknown): AccessPayload {
  const data = objectRecord(value, "access payload");
  const lastAccessed = data.last_accessed;
  const lastCfi = data.last_cfi;
  if (typeof lastAccessed !== "number") {
    throw new Error("access payload is missing last_accessed");
  }
  if (lastCfi !== null && typeof lastCfi !== "string") {
    throw new Error("access payload has an invalid last_cfi");
  }
  return { last_accessed: lastAccessed, last_cfi: lastCfi };
}

interface BookmarkPayload {
  cfi: string;
  page_number: number | null;
  preview: string;
}

function parseBookmarkPayload(value: unknown): BookmarkPayload {
  const data = objectRecord(value, "bookmark payload");
  const pageNumber = data.page_number;
  if (pageNumber !== null && typeof pageNumber !== "number") {
    throw new Error("bookmark payload has an invalid page_number");
  }
  return {
    cfi: stringField(data, "cfi", "bookmark payload"),
    page_number: pageNumber,
    preview:
      data.preview === undefined
        ? ""
        : stringField(data, "preview", "bookmark payload"),
  };
}

interface CatalogPointer {
  catalog_key: string;
  catalog_path: string;
}

function parseCatalogPointer(value: unknown): CatalogPointer {
  const data = objectRecord(value, "catalog pointer");
  return {
    catalog_key: stringField(data, "catalog_key", "catalog pointer"),
    catalog_path: stringField(data, "catalog_path", "catalog pointer"),
  };
}

function parseCatalogEntries(value: unknown): [number, CatalogEntry][] {
  if (!Array.isArray(value)) throw new Error("catalog object must be an array");
  return value.map((entry) => {
    const data = objectRecord(entry, "catalog entry");
    const documentId = data.document_id;
    if (typeof documentId !== "number") {
      throw new Error("catalog entry is missing document_id");
    }
    const catalog = objectRecord(data.catalog, "catalog entry catalog");
    const publisher = catalog.publisher;
    if (
      publisher !== undefined &&
      publisher !== null &&
      typeof publisher !== "string"
    ) {
      throw new Error("catalog entry has an invalid publisher");
    }
    return [
      documentId,
      {
        title: stringField(catalog, "title", "catalog entry"),
        authors: stringArrayField(catalog, "authors", "catalog entry"),
        subjects: stringArrayField(catalog, "subjects", "catalog entry"),
        publisher: publisher ?? null,
      },
    ];
  });
}
