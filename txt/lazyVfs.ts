// Node port of ui/src/data/remoteVfs.ts's full custom sqlite3_vfs (the same
// vendored sqlcipher.js WASM module both sides load -- confirmed identical
// build/API surface, ui/src/data/wasmLoader.ts imports the exact same
// repo-root sqlcipher/sqlcipher.js this CLI does). Unlike r2Vfs.ts (which
// prefetches every current page up front, via the vendored in-memory
// sqlcipher/js-vfs.mjs), this VFS fetches a page only the first time
// xRead actually needs it -- opts.fetchPage is a synchronous call into
// lazyPageClient.ts's worker+Atomics bridge, the same trick remoteVfs.ts
// uses to bridge SQLite's synchronous xRead callback to a real async
// fetch (this WASM build has no Asyncify support -- CLAUDE.md's own
// confirmed constraint -- so a genuine on-demand async fetch from inside
// xRead itself isn't possible any other way).
//
// Exposes the same shape as r2Vfs.ts (currentPageCount/diffDirtyPages/
// markCommitted) rather than remoteVfs.ts's own self-contained
// commit(committer) -- so migrate.ts's existing commit-orchestration code
// (RemotePageStore.commitPages, chunked per MIGRATE_PARTS_PER_COMMIT) works
// against either VFS interchangeably. Unlike r2Vfs.ts's version of
// markCommitted (which has to advance a separate "original snapshot" to
// avoid re-reporting already-committed pages -- a real bug fixed
// elsewhere in this session when that advancing step was missing),
// dirtyPages here already IS the live diff: xWrite populates it, and
// markCommitted simply moves committed entries into the read cache and
// deletes them, so there's no separate baseline to remember to advance.
import { randomBytes } from "node:crypto";

const SQLITE_OK = 0;
const SQLITE_IOERR_SHORT_READ = 522; // 10 | (2 << 8)
const SQLITE_NOTFOUND = 12;

const SQLITE_OPEN_DELETEONCLOSE = 0x00000008;
const SQLITE_ACCESS_EXISTS = 0;

// Bounds how much of a large database's pages stay resident across one
// --migrate run -- unbounded would otherwise grow forever, since nothing
// ever evicted a page once fetched. 2000 pages (~64MB at this build's
// 32768-byte page size) is generous for a CLI process (no browser tab
// memory pressure to worry about), while still bounding a pathological
// case (a run that ends up touching most of a huge database anyway).
const MAX_CACHED_PAGES = 2000;

export interface LazyVfsOptions {
  name?: string;
  pageSize: number;
  pageCount: number;
  dbFileName: string;
  fetchPage: (pageNo: number) => Buffer;
}

export interface LazyVfsHandle {
  name: string;
  readonly currentPageCount: number;
  /** Pages written this session, not yet committed -- populated by xWrite,
   * cleared by markCommitted. Unlike r2Vfs.ts's version, this needs no
   * separate baseline snapshot to stay correct across repeated calls: it's
   * simply whatever's been written and not yet marked committed. */
  diffDirtyPages(): Map<number, Buffer>;
  /** Moves each of these pages from the dirty set into the read cache
   * (so a later read of a just-committed page hits the cache, not the
   * network) and removes it from the dirty set. Call only after the pages
   * have actually been persisted for real -- see r2Vfs.ts's own
   * markCommitted for why (a failed or not-yet-committed page must stay dirty so
   * it's retried, not silently treated as safe). */
  markCommitted(committedPages: Map<number, Buffer>): void;
}

interface OpenFile {
  name: string;
  deleteOnClose: boolean;
  backed: boolean;
}

interface FallbackEntry {
  bytes: Uint8Array;
}

export function registerLazyVfs(mod: any, opts: LazyVfsOptions): LazyVfsHandle {
  const name = opts.name || `lazyvfs-${Date.now()}`;
  const pageCache = new Map<number, Uint8Array>();
  const dirtyPages = new Map<number, Uint8Array>();
  const fallbackFiles = new Map<string, FallbackEntry>();
  const openFiles = new Map<number, OpenFile>();
  const originalPageCount = opts.pageCount;
  let knownPageCount = opts.pageCount;
  let tempCounter = 0;
  let ioMethodsPtr = 0;

  function cacheGet(pageNo: number): Uint8Array | undefined {
    const cached = pageCache.get(pageNo);
    if (cached) {
      pageCache.delete(pageNo);
      pageCache.set(pageNo, cached);
    }
    return cached;
  }

  function cacheSet(pageNo: number, bytes: Uint8Array): void {
    pageCache.delete(pageNo);
    pageCache.set(pageNo, bytes);
    if (pageCache.size > MAX_CACHED_PAGES) {
      const oldest = pageCache.keys().next().value;
      if (oldest !== undefined) pageCache.delete(oldest);
    }
  }

  function getPage(pageNo: number): Uint8Array {
    const cached = cacheGet(pageNo);
    if (cached) return cached;
    const bytes = opts.fetchPage(pageNo);
    cacheSet(pageNo, bytes);
    return bytes;
  }

  function pageBytes(pageNo: number): Uint8Array {
    return dirtyPages.get(pageNo) ?? getPage(pageNo);
  }

  function backedFileSize(): number {
    return knownPageCount * opts.pageSize;
  }

  function fillFromPages(out: Uint8Array, iOfst: number, iAmt: number): number {
    const pageSize = opts.pageSize;
    const end = Math.min(iOfst + iAmt, backedFileSize());
    let pos = iOfst;
    while (pos < end) {
      const pageNo = Math.floor(pos / pageSize) + 1; // 1-indexed, matches pages.pageNo
      const pageStart = (pageNo - 1) * pageSize;
      const srcOff = pos - pageStart;
      const n = Math.min(pageSize - srcOff, end - pos);
      out.set(pageBytes(pageNo).subarray(srcOff, srcOff + n), pos - iOfst);
      pos += n;
    }
    return end - iOfst;
  }

  function xReadBacked(pBuf: number, iAmt: number, iOfst: number): number {
    if (iOfst >= backedFileSize()) {
      mod.HEAPU8.fill(0, pBuf, pBuf + iAmt);
      return SQLITE_IOERR_SHORT_READ;
    }
    const out = new Uint8Array(iAmt);
    const n = fillFromPages(out, iOfst, iAmt);
    mod.HEAPU8.set(out, pBuf);
    return n < iAmt ? SQLITE_IOERR_SHORT_READ : SQLITE_OK;
  }

  // fullOverwrite: true when the caller is about to replace every byte of
  // this page in the same xWrite call (offset 0, amount === pageSize) --
  // SQLite does this for a page it doesn't care about the prior content of
  // (a freshly allocated b-tree node, a page reused off the freelist), so
  // there's no need to fetch that content first just to immediately
  // discard it. Same reasoning as remoteVfs.ts's own dirtyPage.
  function dirtyPage(pageNo: number, fullOverwrite: boolean): Uint8Array {
    let page = dirtyPages.get(pageNo);
    if (page) return page;
    const isNewPage = pageNo > originalPageCount;
    const existing =
      isNewPage || fullOverwrite
        ? new Uint8Array(opts.pageSize)
        : getPage(pageNo);
    page = existing.slice();
    dirtyPages.set(pageNo, page);
    return page;
  }

  function xWriteBacked(pBuf: number, iAmt: number, iOfst: number): number {
    const pageSize = opts.pageSize;
    const end = iOfst + iAmt;
    let pos = iOfst;
    while (pos < end) {
      const pageNo = Math.floor(pos / pageSize) + 1;
      if (pageNo > knownPageCount) knownPageCount = pageNo;
      const pageStart = (pageNo - 1) * pageSize;
      const dstOff = pos - pageStart;
      const n = Math.min(pageSize - dstOff, end - pos);
      const fullOverwrite = dstOff === 0 && n === pageSize;
      const page = dirtyPage(pageNo, fullOverwrite);
      const srcStart = pBuf + (pos - iOfst);
      page.set(mod.HEAPU8.subarray(srcStart, srcStart + n), dstOff);
      pos += n;
    }
    return SQLITE_OK;
  }

  function xTruncateBacked(size: number): number {
    const newPageCount = Math.floor(size / opts.pageSize);
    for (const pageNo of dirtyPages.keys()) {
      if (pageNo > newPageCount) dirtyPages.delete(pageNo);
    }
    knownPageCount = newPageCount;
    return SQLITE_OK;
  }

  // --- fallback (non-backed path) storage -- same behavior as js-vfs.mjs ---

  function fallbackEntry(fname: string): FallbackEntry {
    let entry = fallbackFiles.get(fname);
    if (!entry) {
      entry = { bytes: new Uint8Array(0) };
      fallbackFiles.set(fname, entry);
    }
    return entry;
  }

  function resize(entry: FallbackEntry, newLen: number): void {
    if (newLen === entry.bytes.length) return;
    const next = new Uint8Array(newLen);
    next.set(entry.bytes.subarray(0, Math.min(entry.bytes.length, newLen)));
    entry.bytes = next;
  }

  function xReadFallback(
    fname: string,
    pBuf: number,
    iAmt: number,
    iOfst: number,
  ): number {
    const entry = fallbackEntry(fname);
    const avail = entry.bytes.length - iOfst;
    if (avail <= 0) {
      mod.HEAPU8.fill(0, pBuf, pBuf + iAmt);
      return SQLITE_IOERR_SHORT_READ;
    }
    const n = Math.min(avail, iAmt);
    mod.HEAPU8.set(entry.bytes.subarray(iOfst, iOfst + n), pBuf);
    if (n < iAmt) mod.HEAPU8.fill(0, pBuf + n, pBuf + iAmt);
    return n < iAmt ? SQLITE_IOERR_SHORT_READ : SQLITE_OK;
  }

  function xWriteFallback(
    fname: string,
    pBuf: number,
    iAmt: number,
    iOfst: number,
  ): number {
    const entry = fallbackEntry(fname);
    if (iOfst + iAmt > entry.bytes.length) resize(entry, iOfst + iAmt);
    entry.bytes.set(mod.HEAPU8.subarray(pBuf, pBuf + iAmt), iOfst);
    return SQLITE_OK;
  }

  // --- sqlite3_io_methods (per-open-file) ----------------------------------

  function xClose(pFile: number): number {
    const of = openFiles.get(pFile);
    if (of) {
      if (of.deleteOnClose && !of.backed) fallbackFiles.delete(of.name);
      openFiles.delete(pFile);
    }
    return SQLITE_OK;
  }

  function xRead(
    pFile: number,
    pBuf: number,
    iAmt: number,
    iOfstBig: number | bigint,
  ): number {
    const of = openFiles.get(pFile)!;
    const iOfst = Number(iOfstBig);
    return of.backed
      ? xReadBacked(pBuf, iAmt, iOfst)
      : xReadFallback(of.name, pBuf, iAmt, iOfst);
  }

  function xWrite(
    pFile: number,
    pBuf: number,
    iAmt: number,
    iOfstBig: number | bigint,
  ): number {
    const of = openFiles.get(pFile)!;
    const iOfst = Number(iOfstBig);
    return of.backed
      ? xWriteBacked(pBuf, iAmt, iOfst)
      : xWriteFallback(of.name, pBuf, iAmt, iOfst);
  }

  function xTruncate(pFile: number, sizeBig: number | bigint): number {
    const of = openFiles.get(pFile)!;
    const size = Number(sizeBig);
    if (of.backed) return xTruncateBacked(size);
    resize(fallbackEntry(of.name), size);
    return SQLITE_OK;
  }

  function xSync(_pFile: number, _flags: number): number {
    return SQLITE_OK; // dirty pages stay in-memory until an explicit commit -- see file header
  }

  function xFileSize(pFile: number, pSize: number): number {
    const of = openFiles.get(pFile)!;
    const len = of.backed
      ? backedFileSize()
      : fallbackEntry(of.name).bytes.length;
    mod.HEAP32[pSize >> 2] = len >>> 0;
    mod.HEAP32[(pSize >> 2) + 1] = 0;
    return SQLITE_OK;
  }

  function xLock(_pFile: number, _eLock: number): number {
    return SQLITE_OK;
  }
  function xUnlock(_pFile: number, _eLock: number): number {
    return SQLITE_OK;
  }
  function xCheckReservedLock(_pFile: number, pResOut: number): number {
    mod.HEAP32[pResOut >> 2] = 0;
    return SQLITE_OK;
  }
  function xFileControl(_pFile: number, _op: number, _pArg: number): number {
    return SQLITE_NOTFOUND;
  }
  function xSectorSize(_pFile: number): number {
    return 4096;
  }
  function xDeviceCharacteristics(_pFile: number): number {
    return 0;
  }

  // --- sqlite3_vfs (global) -------------------------------------------------

  function xOpen(
    _pVfs: number,
    zName: number,
    pFile: number,
    flags: number,
    pOutFlags: number,
  ): number {
    const fname = zName
      ? mod.UTF8ToString(zName)
      : `:lazyvfs-temp-${tempCounter++}:`;
    const backed = fname === opts.dbFileName;
    if (!backed) fallbackEntry(fname);
    mod.HEAP32[pFile >> 2] = ioMethodsPtr;
    openFiles.set(pFile, {
      name: fname,
      deleteOnClose: !!(flags & SQLITE_OPEN_DELETEONCLOSE),
      backed,
    });
    if (pOutFlags) mod.HEAP32[pOutFlags >> 2] = flags;
    return SQLITE_OK;
  }

  function xDelete(_pVfs: number, zName: number, _syncDir: number): number {
    fallbackFiles.delete(mod.UTF8ToString(zName));
    return SQLITE_OK;
  }

  function xAccess(
    _pVfs: number,
    zName: number,
    flags: number,
    pResOut: number,
  ): number {
    const fname = mod.UTF8ToString(zName);
    const exists = fname === opts.dbFileName || fallbackFiles.has(fname);
    mod.HEAP32[pResOut >> 2] =
      flags === SQLITE_ACCESS_EXISTS ? (exists ? 1 : 0) : 1;
    return SQLITE_OK;
  }

  function xFullPathname(
    _pVfs: number,
    zName: number,
    nOut: number,
    zOut: number,
  ): number {
    mod.stringToUTF8(mod.UTF8ToString(zName), zOut, nOut);
    return SQLITE_OK;
  }

  function xRandomness(_pVfs: number, nByte: number, zOut: number): number {
    mod.HEAPU8.set(randomBytes(nByte), zOut);
    return nByte;
  }

  function xSleep(_pVfs: number, microseconds: number): number {
    return microseconds; // synchronous VFS -- no real sleep
  }

  function xCurrentTime(_pVfs: number, pTimeOut: number): number {
    mod.HEAPF64[pTimeOut >> 3] = 2440587.5 + Date.now() / 86400000;
    return SQLITE_OK;
  }

  function xGetLastError(_pVfs: number, nBuf: number, zBuf: number): number {
    if (nBuf > 0) mod.HEAPU8[zBuf] = 0;
    return SQLITE_OK;
  }

  const methodPtrs = [
    mod.addFunction(xOpen, "iiiiii"),
    mod.addFunction(xDelete, "iiii"),
    mod.addFunction(xAccess, "iiiii"),
    mod.addFunction(xFullPathname, "iiiii"),
    mod.addFunction(xRandomness, "iiii"),
    mod.addFunction(xSleep, "iii"),
    mod.addFunction(xCurrentTime, "iii"),
    mod.addFunction(xGetLastError, "iiii"),
    mod.addFunction(xClose, "ii"),
    mod.addFunction(xRead, "iiiij"),
    mod.addFunction(xWrite, "iiiij"),
    mod.addFunction(xTruncate, "iij"),
    mod.addFunction(xSync, "iii"),
    mod.addFunction(xFileSize, "iii"),
    mod.addFunction(xLock, "iii"),
    mod.addFunction(xUnlock, "iii"),
    mod.addFunction(xCheckReservedLock, "iii"),
    mod.addFunction(xFileControl, "iiii"),
    mod.addFunction(xSectorSize, "ii"),
    mod.addFunction(xDeviceCharacteristics, "ii"),
  ];

  const ptrBuf = mod._malloc(methodPtrs.length * 4);
  mod.HEAP32.set(methodPtrs, ptrBuf >> 2);

  const nameLen = mod.lengthBytesUTF8(name);
  const namePtr = mod._malloc(nameLen + 1);
  mod.stringToUTF8(name, namePtr, nameLen + 1);

  const szOsFile = 4;
  const mxPathname = 512;
  const rc = mod._sqlite3_js_vfs_register(
    namePtr,
    szOsFile,
    mxPathname,
    0,
    ptrBuf,
  );

  mod._free(namePtr);
  mod._free(ptrBuf);
  if (rc !== SQLITE_OK)
    throw new Error(`sqlite3_js_vfs_register('${name}') failed: rc=${rc}`);

  ioMethodsPtr = mod._sqlite3_js_vfs_io_methods();

  function diffDirtyPages(): Map<number, Buffer> {
    const out = new Map<number, Buffer>();
    for (const [pageNo, bytes] of dirtyPages)
      out.set(pageNo, Buffer.from(bytes));
    return out;
  }

  function markCommitted(committedPages: Map<number, Buffer>): void {
    for (const pageNo of committedPages.keys()) {
      const data = dirtyPages.get(pageNo);
      if (data) {
        cacheSet(pageNo, data);
        dirtyPages.delete(pageNo);
      }
    }
  }

  return {
    name,
    get currentPageCount() {
      return knownPageCount;
    },
    diffDirtyPages,
    markCommitted,
  };
}
