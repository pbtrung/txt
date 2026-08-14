// The client-side half of docs/data_model.md §8.4's cache-validation
// contract: the library index SQLite file, decrypted and decompressed, is
// cached in IndexedDB keyed by a single fixed slot -- there's only ever one
// current library index per account. A read compares built_at_version and
// content_hash against AA's own library_index row (session.ts's
// readLibraryIndexKeys) before deciding whether a GET is needed at all.
const DB_NAME = "txt-library-index-cache";
const STORE_NAME = "libraryIndex";
const KEY = "current";

export interface CachedLibraryIndex {
  builtAtVersion: number;
  contentHash: Uint8Array;
  bytes: Uint8Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Always closes the connection once its transaction settles -- an open
// connection blocks a later deleteDatabase() (and, transitively, any open()
// racing behind it), which is exactly what hung every test here before this
// was factored out.
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = run(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function readCachedLibraryIndex(): Promise<CachedLibraryIndex | null> {
  const result = await withStore<CachedLibraryIndex | undefined>("readonly", (store) => store.get(KEY));
  return result ?? null;
}

export async function writeCachedLibraryIndex(entry: CachedLibraryIndex): Promise<void> {
  await withStore<IDBValidKey>("readwrite", (store) => store.put(entry, KEY));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
