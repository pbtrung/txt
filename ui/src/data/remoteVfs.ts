// Browser port of txt/remoteVfs.ts, extended with real write support: that
// version is read-only (--test-perf never writes), but the browser needs to
// persist bookmarks/read-position/deletes back to the page store.
//
// Design: xWrite/xTruncate on the backed path are fully synchronous and
// in-memory only (a Map of dirty pages) -- SQLite's own xWrite/xSync
// callbacks are synchronous C calls with no way to await a network request,
// the same constraint xRead has, but unlike reads there's no need to bridge
// that here: nothing has to observe the write until the app explicitly asks
// to persist it. That's commit() below -- an async method the caller
// invokes from ordinary JS (e.g. after closing a write transaction), which
// POSTs the accumulated dirty pages as one atomic COMMIT (see
// docs/data_model.md's "commit pattern" and docker/auth_perms.lua). No
// worker/Atomics involvement for writes at all, only for the lazy reads
// (see remotePageWorker.ts).

import { verbose } from "../log";
import type { WasmModule } from "./wasmLoader";
import type { RqliteHttpClient } from "./rqliteHttpClient";

const SQLITE_OK = 0;
const SQLITE_IOERR_SHORT_READ = 522; // 10 | (2 << 8)
const SQLITE_NOTFOUND = 12;

const SQLITE_OPEN_DELETEONCLOSE = 0x00000008;
const SQLITE_ACCESS_EXISTS = 0;

// Bounds how much of a large document's pages stay resident across a long
// reading session -- unbounded would otherwise grow forever, since nothing
// ever evicted a page once fetched. 4000 pages (~16MB at this build's 4KB
// page size) is a small vault-wide budget, not per-document; the cache is
// naturally reset to empty on refresh() anyway (state/VaultContext.tsx's
// refresh path re-opens against a brand new registerRemoteVfs() call, a
// fresh closure with its own fresh cache, not this one reused). Exported
// so dbWorker.ts's open() can cap its own batched prefetch (see
// primeCache below) at the same size -- fetching more pages up front than
// the cache can hold would just evict some of them before SQLite ever
// gets to read them.
export const MAX_CACHED_PAGES = 4000;

export interface RemoteVfsOptions {
  name?: string;
  pageSize: number;
  pageCount: number;
  currentVersion: number;
  backedPath: string;
  fetchPage: (pageNo: number) => Uint8Array;
  /** Required on COMMIT when the caller's api key is role='admin' -- see
   * rqliteHttpClient.ts's resolveTargetDbId. undefined for a genuine
   * user-role key, which the server forces to its own db_id already. */
  targetDbId?: string;
}

export interface RoundtripStat {
  pageNo: number;
  ms: number;
}

export interface RemoteVfsStats {
  roundtrips: RoundtripStat[];
  bytesFetched: number;
}

export interface RemoteVfsHandle {
  name: string;
  stats: RemoteVfsStats;
  isDirty(): boolean;
  /** Flushes dirty pages via one atomic COMMIT. Returns false (no throw) if
   * another writer's commit won the race -- caller must reopen against the
   * new server version and redo its writes, per the CAS retry rule in
   * docs/data_model.md. */
  commit(client: RqliteHttpClient): Promise<boolean>;
  /** Seeds the page cache with pages already fetched via a batched request
   * (dbWorker.ts's open()) -- so SQLite's own later page-at-a-time xRead
   * calls find them already resident instead of each triggering its own
   * individual network round trip. */
  primeCache(pages: Map<number, Uint8Array>): void;
  /** The version last successfully committed (or the version opened at, if
   * nothing's been committed yet this session). dbWorker.ts reads this
   * right after a successful commit() to advance remotePageClient.ts's
   * page-fetch worker's own pinned snapshot (RemotePageBridge.
   * updateSnapshot) -- without that, a live fetch for a page that only
   * exists as of the new version (freshly written this session, evicted
   * from the cache or never cached at all) would come back "not found"
   * against the stale snapshot that worker started with. */
  getCurrentVersion(): number;
}

interface OpenFile {
  name: string;
  deleteOnClose: boolean;
  backed: boolean;
}

interface FallbackEntry {
  bytes: Uint8Array;
}

export function registerRemoteVfs(
  mod: WasmModule,
  opts: RemoteVfsOptions,
): RemoteVfsHandle {
  const name = opts.name || "remotevfs";
  const stats: RemoteVfsStats = { roundtrips: [], bytesFetched: 0 };
  const pageCache = new Map<number, Uint8Array>();
  const dirtyPages = new Map<number, Uint8Array>();
  const fallbackFiles = new Map<string, FallbackEntry>();
  const openFiles = new Map<number, OpenFile>();
  const originalPageCount = opts.pageCount;
  let knownPageCount = opts.pageCount;
  let currentVersion = opts.currentVersion;
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
    const start = performance.now();
    const bytes = opts.fetchPage(pageNo);
    stats.roundtrips.push({ pageNo, ms: performance.now() - start });
    stats.bytesFetched += bytes.length;
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
      const pageNo = Math.floor(pos / pageSize) + 1; // 1-indexed, matches pages.page_no
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

  /** fullOverwrite: true when the caller is about to replace every byte of
   * this page in the same xWrite call (offset 0, amount === pageSize) --
   * SQLite does this for a page it doesn't care about the prior content of
   * (a freshly allocated b-tree node, a page reused off the freelist), so
   * there's no need to fetch that content first just to immediately
   * discard all of it. This isn't just an optimization: a page reused from
   * the freelist can be numbered within originalPageCount (the server's
   * own reported page count) while genuinely having no fetchable content
   * at the current snapshot -- fetching it here would throw even though
   * the write about to happen never needed the old bytes at all. */
  function dirtyPage(pageNo: number, fullOverwrite: boolean): Uint8Array {
    let page = dirtyPages.get(pageNo);
    if (page) return page;
    const isNewPage = pageNo > originalPageCount;
    const existing =
      isNewPage || fullOverwrite
        ? new Uint8Array(opts.pageSize)
        : getPage(pageNo);
    verbose(
      `remoteVfs: dirtying page ${pageNo} (${
        isNewPage
          ? "new, beyond original page count " + originalPageCount
          : fullOverwrite
            ? "existing, but fully overwritten -- skipped fetching prior content"
            : "existing, fetched/cached first"
      })`,
    );
    page = existing.slice();
    dirtyPages.set(pageNo, page);
    return page;
  }

  function xWriteBacked(pBuf: number, iAmt: number, iOfst: number): number {
    const pageSize = opts.pageSize;
    const end = iOfst + iAmt;
    let pos = iOfst;
    const firstPageNo = Math.floor(iOfst / pageSize) + 1;
    const lastPageNo = Math.floor((end - 1) / pageSize) + 1;
    verbose(
      `remoteVfs: xWrite offset=${iOfst} amount=${iAmt} -> page(s) ${firstPageNo}` +
        (lastPageNo !== firstPageNo ? `-${lastPageNo}` : ""),
    );
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
    return SQLITE_OK; // dirty pages stay in-memory until an explicit commit() -- see file header
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
      : `:remotevfs-temp-${tempCounter++}:`;
    const backed = fname === opts.backedPath;
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
    const exists = fname === opts.backedPath || fallbackFiles.has(fname);
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
    const bytes = new Uint8Array(nByte);
    globalThis.crypto.getRandomValues(bytes);
    mod.HEAPU8.set(bytes, zOut);
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

  async function commit(client: RqliteHttpClient): Promise<boolean> {
    if (dirtyPages.size === 0) return true;
    const pages = Array.from(dirtyPages.entries()).map(([pageNo, data]) => ({
      pageNo,
      data,
    }));
    const newVersion = currentVersion + 1;
    verbose(
      `remoteVfs: commit ${currentVersion} -> ${newVersion}, ${pages.length} dirty page(s): ` +
        `[${pages.map((p) => p.pageNo).join(", ")}], knownPageCount=${knownPageCount}`,
    );
    const ok = await client.commit(
      pages,
      currentVersion,
      newVersion,
      knownPageCount,
      opts.targetDbId,
    );
    if (!ok) {
      verbose(
        `remoteVfs: commit ${currentVersion} -> ${newVersion} lost the CAS race`,
      );
      return false;
    }
    currentVersion = newVersion;
    for (const [pageNo, data] of dirtyPages) cacheSet(pageNo, data);
    dirtyPages.clear();
    return true;
  }

  function primeCache(pages: Map<number, Uint8Array>): void {
    for (const [pageNo, bytes] of pages) cacheSet(pageNo, bytes);
  }

  return {
    name,
    stats,
    isDirty: () => dirtyPages.size > 0,
    commit,
    primeCache,
    getCurrentVersion: () => currentVersion,
  };
}
