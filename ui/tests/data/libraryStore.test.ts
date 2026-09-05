import { describe, expect, it, vi } from "vitest";
import {
  decrypt,
  decryptJson,
  encrypt,
  encryptJson,
} from "../../src/crypto/cryptoBlob";
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
import { fromBase64, toBase64 } from "../../src/util/base64";

const UMK = crypto.getRandomValues(new Uint8Array(128));
const SIGNING = {} as OwnerSigningIdentity;
const DB_PREFIX = "a".repeat(52);

async function wrapKey(key: Uint8Array): Promise<Uint8Array> {
  return encrypt(key, UMK);
}

// A document that has been opened at least once -- what
// fetchLibrary()'s documents/fetchDocument() return for it
// (docs/data_model.md §2/§3). Visibility in the library still needs a matching catalogRow()
// entry: identity/browse metadata is catalog-driven now, not documents-
// driven, so a book with access state but no catalog entry is invisible
// (see the "invisible until next ingestion run" test below).
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

// A document that has never been opened: fetchLibrary()'s documents
// never includes it (that's the whole point of the underlying query),
// but fetchDocument() still can -- LibraryStore.ensureSecret() calls it
// lazily the first time such a document's reading position is written.
function documentRowWithoutAccess(id: number): DocumentRow {
  return {
    id,
    createdAt: 0,
    accessBlob: null,
    accessVersion: 0,
    accessKeyWrapped: null,
  };
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
    fetchLibrary: vi
      .fn()
      .mockResolvedValue({ documents: [], catalog: null, summaries: [] }),
    fetchDocument: vi.fn().mockResolvedValue(null),
    fetchDocumentContent: vi.fn().mockResolvedValue(null),
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
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [document], catalog, summaries: [summary] }),
      fetchDocumentContent: vi.fn().mockResolvedValue(content),
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

  it("a malformed access_blob doesn't hide the book, just defaults its recency", async () => {
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
    const { row: catalog, objectBytes } = await catalogRow([
      { documentId: 1, title: "Good" },
      { documentId: 2, title: "Bad Access State" },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = fakeApi({
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [good, bad], catalog, summaries: [] }),
    });

    const store = await LibraryStore.open(
      api,
      fakeStorage(objectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );

    // Both books still appear -- the catalog, not access state, decides
    // visibility -- but the one whose access_blob failed to decrypt
    // falls back to never-accessed defaults instead of losing the book.
    const good_ = store.snapshot().find((book) => book.txtId === 1);
    const bad_ = store.snapshot().find((book) => book.txtId === 2);
    expect(good_?.lastAccessed).toBe(10);
    expect(bad_?.lastAccessed).toBe(0);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("access state for document 2"),
    );
    consoleError.mockRestore();
  });

  it("skips a malformed catalog entry instead of failing the whole reload", async () => {
    const { row: catalog } = await catalogRow([{ documentId: 1, title: "Good" }]);
    // Corrupt the one entry's document_id so parseCatalogEntry() throws
    // for it specifically, alongside a second, well-formed entry.
    const rowKey = await decrypt(catalog.keyWrapped, UMK);
    const pointer = await decryptJson<{ catalog_key: string; catalog_path: string }>(
      catalog.catalogBlob,
      rowKey,
    );
    const catalogKey = fromBase64(pointer.catalog_key);
    const entries = [
      { document_id: 1, catalog: { title: "Good", authors: [], subjects: [] } },
      {
        document_id: "not-a-number",
        catalog: { title: "Bad", authors: [], subjects: [] },
      },
    ];
    const brokenObjectBytes = await encryptJson(entries, catalogKey);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api = fakeApi({
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [], catalog, summaries: [] }),
    });

    const store = await LibraryStore.open(
      api,
      fakeStorage(brokenObjectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );

    expect(store.snapshot().map((book) => book.txtId)).toEqual([1]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("malformed catalog entry"),
    );
    consoleError.mockRestore();
  });

  it("leaves a document with access state but no catalog entry invisible", async () => {
    const { row: document } = await documentRow(2, "p", {
      lastAccessed: 0,
      lastCfi: null,
    });
    const api = fakeApi({
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [document], catalog: null, summaries: [] }),
    });
    const store = await LibraryStore.open(api, fakeStorage(), SIGNING, DB_PREFIX, UMK);

    // docs/data_model.md §2.1: a documents row not yet reflected in the
    // catalog is invisible until the next ingestion run, not shown with
    // placeholder metadata -- ingestion re-runs are what reconcile it.
    expect(store.snapshot()).toEqual([]);
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
    const { row: catalog, objectBytes } = await catalogRow([
      { documentId: 1, title: "Book" },
    ]);
    const refreshedAccessBlob = await encryptJson(
      { last_accessed: 0, last_cfi: "server-wins" },
      accessKey,
    );
    const updateDocumentAccess = vi
      .fn()
      .mockRejectedValueOnce(new AccessVersionConflictError())
      .mockResolvedValueOnce(2);
    const api = fakeApi({
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [document], catalog, summaries: [] }),
      fetchDocument: vi.fn().mockResolvedValue({
        ...document,
        accessBlob: refreshedAccessBlob,
        accessVersion: 1,
      }),
      updateDocumentAccess,
    });
    const store = await LibraryStore.open(
      api,
      fakeStorage(objectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );

    await store.updateReadingPosition(1, "new-cfi", 42);

    expect(updateDocumentAccess).toHaveBeenCalledTimes(2);
    expect(updateDocumentAccess.mock.calls[0][2]).toBe(0);
    expect(updateDocumentAccess.mock.calls[1][2]).toBe(1);
    expect(store.snapshot()[0].lastAccessed).toBe(42);
  });

  it("mints a fresh access key on a never-accessed document's first write", async () => {
    const { row: catalog, objectBytes } = await catalogRow([
      { documentId: 1, title: "Book" },
    ]);
    const updateDocumentAccess = vi.fn().mockResolvedValue(1);
    const api = fakeApi({
      // Never in fetchLibrary()'s documents -- ensureSecret() must fetch
      // it lazily via fetchDocument() instead.
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [], catalog, summaries: [] }),
      fetchDocument: vi.fn().mockResolvedValue(documentRowWithoutAccess(1)),
      updateDocumentAccess,
    });
    const store = await LibraryStore.open(
      api,
      fakeStorage(objectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );

    await store.updateReadingPosition(1, "new-cfi", 42);

    expect(api.fetchDocument).toHaveBeenCalledWith(1);
    expect(updateDocumentAccess).toHaveBeenCalledTimes(1);
    const write = updateDocumentAccess.mock.calls[0][1];
    expect(write.kind).toBe("first");
    const accessKey = await decrypt(write.accessKeyWrapped, UMK);
    const payload = await decryptJson<{ last_accessed: number; last_cfi: string }>(
      write.accessBlob,
      accessKey,
    );
    expect(payload).toEqual({ last_accessed: 42, last_cfi: "new-cfi" });
    expect(store.snapshot()[0].lastAccessed).toBe(42);
  });
});

describe("LibraryStore.clearLastAccessed", () => {
  it("sends a clear write and resets the book's lastAccessed to 0", async () => {
    const { row: document } = await documentRow(1, "p", {
      lastAccessed: 500,
      lastCfi: "cfi-1",
    });
    const { row: catalog, objectBytes } = await catalogRow([
      { documentId: 1, title: "Book" },
    ]);
    const updateDocumentAccess = vi.fn().mockResolvedValue(1);
    const api = fakeApi({
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [document], catalog, summaries: [] }),
      updateDocumentAccess,
    });
    const store = await LibraryStore.open(
      api,
      fakeStorage(objectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );

    await store.clearLastAccessed(1);

    expect(updateDocumentAccess).toHaveBeenCalledWith(
      1,
      { kind: "clear" },
      0,
      SIGNING,
      DB_PREFIX,
    );
    expect(store.snapshot()[0].lastAccessed).toBe(0);
  });

  it("is a no-op for a document with no access state yet", async () => {
    const updateDocumentAccess = vi.fn();
    const api = fakeApi({ updateDocumentAccess });
    const store = await LibraryStore.open(api, fakeStorage(), SIGNING, DB_PREFIX, UMK);

    await store.clearLastAccessed(1);

    expect(updateDocumentAccess).not.toHaveBeenCalled();
    expect(api.fetchDocument).not.toHaveBeenCalled();
  });
});

describe("LibraryStore bookmarks", () => {
  it("reloads the bookmark summary after saving a new bookmark", async () => {
    const { row: document } = await documentRow(1, "p", {
      lastAccessed: 0,
      lastCfi: null,
    });
    const { row: catalog, objectBytes } = await catalogRow([
      { documentId: 1, title: "Book" },
    ]);
    const summaryAfter = await bookmarkSummaryRow(5, 1, "new-cfi", 1);
    const api = fakeApi({
      fetchLibrary: vi
        .fn()
        .mockResolvedValue({ documents: [document], catalog, summaries: [] }),
      fetchBookmarksSummary: vi.fn().mockResolvedValue([summaryAfter]),
      createBookmark: vi.fn().mockResolvedValue(5),
    });
    const store = await LibraryStore.open(
      api,
      fakeStorage(objectBytes),
      SIGNING,
      DB_PREFIX,
      UMK,
    );
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
