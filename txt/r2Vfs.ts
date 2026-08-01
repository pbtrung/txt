// Adapts the vendored sqlcipher/js-vfs.mjs (an in-memory sqlite3_vfs, proven
// but not persistent) into a page-by-page-over-R2 VFS, without touching its
// C-level callback plumbing at all: seed its backing Map with prefetched
// page bytes before SQLite touches the file, let xRead/xWrite run purely
// synchronously against that in-memory buffer as they already do, then diff
// the final bytes against the prefetched snapshot to find dirty pages for an
// explicit, separate async flush. Needed because the vendored WASM build has
// no Asyncify support (confirmed: no true async-from-a-sync-C-callback path
// exists), so genuine on-demand fetches mid-xRead aren't possible.
import { registerJsVfs } from "../sqlcipher/js-vfs.mjs";
import * as C from "./constants.ts";
import type { RemotePageStore } from "./remotePageStore.ts";

type FilesMap = Map<string, { bytes: Uint8Array }>;

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatPages(
  pages: Map<number, Uint8Array>,
  pageCount: number,
  pageSize: number,
): Uint8Array {
  const out = new Uint8Array(pageCount * pageSize);
  for (const [pageNo, bytes] of pages) out.set(bytes, (pageNo - 1) * pageSize);
  return out;
}

export class R2Vfs {
  readonly name: string;
  private files: FilesMap;
  private pageSize: number;
  private dbFileName: string;
  private originalPages: Map<number, Uint8Array>;

  private constructor(
    name: string,
    files: FilesMap,
    pageSize: number,
    dbFileName: string,
    originalPages: Map<number, Uint8Array>,
  ) {
    this.name = name;
    this.files = files;
    this.pageSize = pageSize;
    this.dbFileName = dbFileName;
    this.originalPages = originalPages;
  }

  // A brand-new database, nothing to prefetch (pageCount starts at 0).
  static registerNew(module: any, dbFileName: string, pageSize: number): R2Vfs {
    const { name, files } = registerJsVfs(module, {
      name: `r2vfs-${Date.now()}`,
    });
    return new R2Vfs(name, files, pageSize, dbFileName, new Map());
  }

  // An existing database: downloads every current page up front, since
  // xRead/xWrite can't do it lazily (see file header).
  static async registerExisting(
    module: any,
    dbFileName: string,
    pageSize: number,
    pageCount: number,
    version: number,
    store: RemotePageStore,
  ): Promise<R2Vfs> {
    const { name, files } = registerJsVfs(module, {
      name: `r2vfs-${Date.now()}`,
    });
    const originalPages = await R2Vfs.prefetchPages(store, pageCount, version);
    files.set(dbFileName, {
      bytes: concatPages(originalPages, pageCount, pageSize),
    });
    return new R2Vfs(name, files, pageSize, dbFileName, originalPages);
  }

  // Same bounded-concurrency batching as RemotePageStore's upload side --
  // one page at a time is slow for a database of any real size (each page
  // is itself a query + a pointer download + an R2 GET), and an unbounded
  // Promise.all over every page risks exhausting connections.
  private static async prefetchPages(
    store: RemotePageStore,
    pageCount: number,
    version: number,
  ): Promise<Map<number, Uint8Array>> {
    const pageNos = Array.from({ length: pageCount }, (_, i) => i + 1);
    const pages = new Map<number, Uint8Array>();
    for (let i = 0; i < pageNos.length; i += C.R2_BATCH_CONCURRENCY) {
      const batch = pageNos.slice(i, i + C.R2_BATCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map((pageNo) => store.fetchPage(pageNo, version)),
      );
      batch.forEach((pageNo, idx) => pages.set(pageNo, results[idx]));
    }
    return pages;
  }

  get currentPageCount(): number {
    const entry = this.files.get(this.dbFileName);
    return entry ? Math.ceil(entry.bytes.length / this.pageSize) : 0;
  }

  // Pages whose bytes differ from the prefetched snapshot (or that didn't
  // exist in it at all -- newly-grown pages), keyed by 1-based page number.
  diffDirtyPages(): Map<number, Buffer> {
    const entry = this.files.get(this.dbFileName);
    if (!entry) return new Map();
    const dirty = new Map<number, Buffer>();
    for (let pageNo = 1; pageNo <= this.currentPageCount; pageNo++) {
      const page = this.pageBytes(entry.bytes, pageNo);
      if (this.pageChanged(pageNo, page)) dirty.set(pageNo, Buffer.from(page));
    }
    return dirty;
  }

  private pageBytes(bytes: Uint8Array, pageNo: number): Uint8Array {
    const start = (pageNo - 1) * this.pageSize;
    return bytes.subarray(start, start + this.pageSize);
  }

  private pageChanged(pageNo: number, page: Uint8Array): boolean {
    const original = this.originalPages.get(pageNo);
    return !original || !buffersEqual(original, page);
  }
}
