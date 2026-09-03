import { describe, expect, it, vi } from "vitest";
import { encrypt, encryptJson } from "../../src/crypto/cryptoBlob";
import {
  AccessVersionConflictError,
  type ApiClient,
  type BookmarkSummaryRow,
  type CatalogRow,
  type DocumentContent,
  type DocumentRow,
} from "../../src/data/apiClient";
import { LibraryStore, truncateUtf8 } from "../../src/data/libraryStore";
import type { OwnerSigningIdentity } from "../../src/data/ownerProof";
import type { R2Session } from "../../src/data/r2Session";
import { toBase64 } from "../../src/util/base64";

const UMK = crypto.getRandomValues(new Uint8Array(128));
const SIGNING = {} as OwnerSigningIdentity;
const DB_PREFIX = "a".repeat(52);

async function wrapKey(key: Uint8Array): Promise<Uint8Array> {
  return encrypt(key, UMK);
}

async function documentRow(
  id: number,
  path: string,
  access: { lastAccessed: number; lastCfi: string | null },
  accessVersion = 0,
): Promise<{ row: DocumentRow; accessKey: Uint8Array; content: DocumentContent }> {
  const contentKeyRow = crypto.getRandomValues(new Uint8Array(128));
  const contentKey = crypto.getRandomValues(new Uint8Array(128));
  const accessKeyRow = crypto.getRandomValues(new Uint8Array(128));
  const row: DocumentRow = {
    id,
    createdAt: 0,
    accessBlob: await encryptJson(
      { last_accessed: access.lastAccessed, last_cfi: access.lastCfi },
      accessKeyRow,
    ),
    accessVersion,
    accessKeyWrapped: await wrapKey(accessKeyRow),
  };
  const content: DocumentContent = {
    contentBlob: await encryptJson(
      { content_key: toBase64(contentKey), path },
      contentKeyRow,
    ),
    contentKeyWrapped: await wrapKey(contentKeyRow),
  };
  return { row, accessKey: accessKeyRow, content };
}

async function catalogRow(entries: { documentId: number; title: string }[]): Promise<{
  row: CatalogRow;
  objectBytes: Uint8Array;
}> {
  const rowKey = crypto.getRandomValues(new Uint8Array(128));
  const catalogKey = crypto.getRandomValues(new Uint8Array(128));
  const objectBytes = await encryptJson(
    entries.map((entry) => ({
      document_id: entry.documentId,
      catalog: {
        title: entry.title,
        authors: [],
        subjects: [],
        publisher: null,
      },
    })),
    catalogKey,
  );
  const row: CatalogRow = {
    keyWrapped: await wrapKey(rowKey),
    catalogBlob: await encryptJson(
      { catalog_key: toBase64(catalogKey), catalog_path: "cat-path" },
      rowKey,
    ),
  };
  return { row, objectBytes };
}

async function bookmarkSummaryRow(
  id: number,
  documentId: number,
  cfi: string,
  count: number,
  createdAt = 1000,
): Promise<BookmarkSummaryRow> {
  const rowKey = crypto.getRandomValues(new Uint8Array(128));
  return {
    id,
    documentId,
    count,
    keyWrapped: await wrapKey(rowKey),
    bookmarkBlob: await encryptJson({ cfi, page_number: 3, preview: "..." }, rowKey),
    createdAt,
  };
}

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    fetchDocuments: vi.fn().mockResolvedValue([]),
    fetchDocumentContent: vi.fn().mockResolvedValue(null),
    fetchCatalog: vi.fn().mockResolvedValue(null),
    fetchBookmarksSummary: vi.fn().mockResolvedValue([]),
    fetchBookmarks: vi.fn().mockResolvedValue([]),
    updateDocumentAccess: vi.fn(),
    createBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

function fakeStorage(objectBytes?: Uint8Array): R2Session {
  return {
    getCatalogObject: vi.fn().mockResolvedValue(objectBytes ?? null),
  } as unknown as R2Session;
}

describe("LibraryStore.open", () => {
  it("decrypts documents and joins them against the catalog and bookmark summary", async () => {
    const {
      row: document,
      accessKey: _accessKey,
      content,
    } = await documentRow(1, "epub-path", { lastAccessed: 500, lastCfi: "cfi-1" });
    const { row: catalog, objectBytes } = await catalogRow([
      { documentId: 1, title: "Book One" },
    ]);
    const summary = await bookmarkSummaryRow(9, 1, "cfi-1", 2);

    const api = fakeApi({
      fetchDocuments: vi.fn().mockResolvedValue([document]),
      fetchDocumentContent: vi.fn().mockResolvedValue(content),
      fetchCatalog: vi.fn().mockResolvedValue(catalog),
      fetchBookmarksSummary: vi.fn().mockResolvedValue([summary]),
    });
    const store = await LibraryStore.open(
      api,
      fakeStorage(objectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );

    const [book] = store.snapshot();
    expect(book.txtId).toBe(1);
    expect(book.title).toBe("Book One");
    expect(book.lastAccessed).toBe(500);
    expect(book.bookmarkCount).toBe(2);
    expect(book.latestBookmarkCfi).toBe("cfi-1");
    expect(book.bookmarks).toEqual([
      { id: 9, cfi: "cfi-1", pageNumber: 3, createdAt: 1000 },
    ]);

    const document2 = await store.getReaderDocument(1);
    expect(document2?.path).toBe("epub-path");
    expect(document2?.title).toBe("Book One");
  });

  it("skips a malformed document row instead of failing the whole reload", async () => {
    const { row: good } = await documentRow(1, "p1", {
      lastAccessed: 10,
      lastCfi: null,
    });
    const { row: bad } = await documentRow(2, "p2", { lastAccessed: 0, lastCfi: null });
    const badAccessKey = crypto.getRandomValues(new Uint8Array(128));
    // last_accessed must be a number -- this fails parseAccessPayload(),
    // overriding the well-formed access fields documentRow() built.
    bad.accessBlob = await encryptJson({ last_accessed: "not-a-number" }, badAccessKey);
    bad.accessKeyWrapped = await wrapKey(badAccessKey);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = fakeApi({ fetchDocuments: vi.fn().mockResolvedValue([good, bad]) });

    const store = await LibraryStore.open(api, fakeStorage(), SIGNING, DB_PREFIX, UMK);

    expect(store.snapshot().map((book) => book.txtId)).toEqual([1]);
    expect(store.statusSnapshot().error).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("document 2"));
    consoleError.mockRestore();
  });

  it("falls back to placeholder catalog fields for a document missing from the catalog", async () => {
    const { row: document } = await documentRow(2, "p", {
      lastAccessed: 0,
      lastCfi: null,
    });
    const api = fakeApi({ fetchDocuments: vi.fn().mockResolvedValue([document]) });
    const store = await LibraryStore.open(api, fakeStorage(), SIGNING, DB_PREFIX, UMK);

    const [book] = store.snapshot();
    expect(book.title).toBe("Untitled");
    expect(book.bookmarkCount).toBe(0);
    expect(book.bookmarks).toEqual([]);
  });
});

describe("LibraryStore.updateReadingPosition", () => {
  it("retries once against a freshly fetched access_version after a 412", async () => {
    const { row: document, accessKey } = await documentRow(
      1,
      "p",
      { lastAccessed: 0, lastCfi: null },
      0,
    );
    const refreshedAccessBlob = await encryptJson(
      { last_accessed: 0, last_cfi: "server-wins" },
      accessKey,
    );
    const updateDocumentAccess = vi
      .fn()
      .mockRejectedValueOnce(new AccessVersionConflictError())
      .mockResolvedValueOnce(2);
    const api = fakeApi({
      fetchDocuments: vi
        .fn()
        .mockResolvedValueOnce([document])
        .mockResolvedValueOnce([
          { ...document, accessBlob: refreshedAccessBlob, accessVersion: 1 },
        ]),
      updateDocumentAccess,
    });
    const store = await LibraryStore.open(api, fakeStorage(), SIGNING, DB_PREFIX, UMK);

    await store.updateReadingPosition(1, "new-cfi", 42);

    expect(updateDocumentAccess).toHaveBeenCalledTimes(2);
    expect(updateDocumentAccess.mock.calls[0][2]).toBe(0);
    expect(updateDocumentAccess.mock.calls[1][2]).toBe(1);
    expect(store.snapshot()[0].lastAccessed).toBe(42);
  });
});

describe("LibraryStore bookmarks", () => {
  it("reloads the bookmark summary after saving a new bookmark", async () => {
    const { row: document } = await documentRow(1, "p", {
      lastAccessed: 0,
      lastCfi: null,
    });
    const summaryAfter = await bookmarkSummaryRow(5, 1, "new-cfi", 1);
    const api = fakeApi({
      fetchDocuments: vi.fn().mockResolvedValue([document]),
      fetchBookmarksSummary: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([summaryAfter]),
      createBookmark: vi.fn().mockResolvedValue(5),
    });
    const store = await LibraryStore.open(api, fakeStorage(), SIGNING, DB_PREFIX, UMK);
    expect(store.snapshot()[0].bookmarkCount).toBe(0);

    await store.saveBookmark(1, "new-cfi", 3, "preview text");

    expect(api.createBookmark).toHaveBeenCalled();
    expect(store.snapshot()[0].bookmarkCount).toBe(1);
    expect(store.snapshot()[0].latestBookmarkCfi).toBe("new-cfi");
  });
});

describe("truncateUtf8", () => {
  it("truncates on a whole UTF-8 character boundary", () => {
    expect(truncateUtf8("abc", 2)).toBe("ab");
    expect(
      new TextEncoder().encode(truncateUtf8(`  ${"é".repeat(60)}   tail  `, 100))
        .byteLength,
    ).toBeLessThanOrEqual(100);
  });
});
