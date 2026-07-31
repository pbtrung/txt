// A sqlite3_vfs, modeled on sqlcipher/js-vfs.mjs's registration mechanism
// (same Module.addFunction/sqlite3_js_vfs_register wiring), whose xRead
// lazily fetches pages of exactly one path -- opts.backedPath, the actual
// database file -- from a remote page store instead of serving them from a
// preloaded in-memory byte image the way js-vfs.mjs's plain Map-backed VFS
// does. Every other path (temp files, a rollback journal if one is ever
// opened) falls back to that same plain growable-buffer behavior, since
// this VFS is only meant to make the one real database file lazy.
//
// opts.fetchPage does the actual fetch and is expected to block
// synchronously until it has the page's bytes -- see remotePageWorker.ts
// for the worker+Atomics bridge that makes that possible despite this
// method being called synchronously from WASM. This module only knows it
// calls a synchronous function and times how long that took.

import type { WasmModule } from "./wasm.ts";

const SQLITE_OK = 0;
const SQLITE_IOERR = 10;
const SQLITE_IOERR_SHORT_READ = 522; // 10 | (2 << 8)
const SQLITE_NOTFOUND = 12;

const SQLITE_OPEN_DELETEONCLOSE = 0x00000008;
const SQLITE_ACCESS_EXISTS = 0;

export interface RemoteVfsOptions {
  name?: string;
  pageSize: number;
  pageCount: number;
  backedPath: string;
  fetchPage: (pageNo: number) => Uint8Array;
}

export interface RoundtripStat {
  pageNo: number;
  ms: number;
}

export interface RemoteVfsStats {
  roundtrips: RoundtripStat[];
  bytesFetched: number;
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
): { name: string; stats: RemoteVfsStats } {
  const name = opts.name || "remotevfs";
  const stats: RemoteVfsStats = { roundtrips: [], bytesFetched: 0 };
  const pageCache = new Map<number, Uint8Array>();
  const fallbackFiles = new Map<string, FallbackEntry>();
  const openFiles = new Map<number, OpenFile>();
  let tempCounter = 0;
  let ioMethodsPtr = 0;

  function getPage(pageNo: number): Uint8Array {
    const cached = pageCache.get(pageNo);
    if (cached) return cached;
    const start = performance.now();
    const bytes = opts.fetchPage(pageNo);
    stats.roundtrips.push({ pageNo, ms: performance.now() - start });
    stats.bytesFetched += bytes.length;
    pageCache.set(pageNo, bytes);
    return bytes;
  }

  function backedFileSize(): number {
    return opts.pageCount * opts.pageSize;
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
      out.set(getPage(pageNo).subarray(srcOff, srcOff + n), pos - iOfst);
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

  function xReadFallback(fname: string, pBuf: number, iAmt: number, iOfst: number): number {
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

  function xWriteFallback(fname: string, pBuf: number, iAmt: number, iOfst: number): number {
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

  function xRead(pFile: number, pBuf: number, iAmt: number, iOfstBig: number | bigint): number {
    const of = openFiles.get(pFile)!;
    const iOfst = Number(iOfstBig);
    return of.backed ? xReadBacked(pBuf, iAmt, iOfst) : xReadFallback(of.name, pBuf, iAmt, iOfst);
  }

  function xWrite(pFile: number, pBuf: number, iAmt: number, iOfstBig: number | bigint): number {
    const of = openFiles.get(pFile)!;
    if (of.backed) return SQLITE_IOERR; // read-only: writing the real db is never expected
    return xWriteFallback(of.name, pBuf, iAmt, Number(iOfstBig));
  }

  function xTruncate(pFile: number, sizeBig: number | bigint): number {
    const of = openFiles.get(pFile)!;
    if (of.backed) return SQLITE_IOERR;
    resize(fallbackEntry(of.name), Number(sizeBig));
    return SQLITE_OK;
  }

  function xSync(_pFile: number, _flags: number): number {
    return SQLITE_OK;
  }

  function xFileSize(pFile: number, pSize: number): number {
    const of = openFiles.get(pFile)!;
    const len = of.backed ? backedFileSize() : fallbackEntry(of.name).bytes.length;
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
    const fname = zName ? mod.UTF8ToString(zName) : `:remotevfs-temp-${tempCounter++}:`;
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

  function xAccess(_pVfs: number, zName: number, flags: number, pResOut: number): number {
    const fname = mod.UTF8ToString(zName);
    const exists = fname === opts.backedPath || fallbackFiles.has(fname);
    mod.HEAP32[pResOut >> 2] = flags === SQLITE_ACCESS_EXISTS ? (exists ? 1 : 0) : 1;
    return SQLITE_OK;
  }

  function xFullPathname(_pVfs: number, zName: number, nOut: number, zOut: number): number {
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
  const rc = mod._sqlite3_js_vfs_register(namePtr, szOsFile, mxPathname, 0, ptrBuf);

  mod._free(namePtr);
  mod._free(ptrBuf);
  if (rc !== SQLITE_OK) throw new Error(`sqlite3_js_vfs_register('${name}') failed: rc=${rc}`);

  ioMethodsPtr = mod._sqlite3_js_vfs_io_methods();

  return { name, stats };
}
