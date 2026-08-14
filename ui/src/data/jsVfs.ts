// A direct TypeScript port of sqlcipher/js-vfs.mjs -- a JS-backed
// sqlite3_vfs whose xOpen/xRead/xWrite/... are plain functions turned into
// real, indirectly-callable wasm function pointers via Module.addFunction()
// (the build's -sALLOW_TABLE_GROWTH=1), wired into an actual C sqlite3_vfs
// struct by sqlite3_js_vfs_register(). This is the exact piece
// txt/bb_engine.py's own register_js_vfs was itself ported *from* (to
// wasmtime's Table.grow/.set, since Python has no addFunction) -- porting
// back to Emscripten's own API is close to mechanical.
//
// Storage backend: a plain in-memory Map from filename to a growable
// Uint8Array, exactly like the original -- not persistent beyond this
// object's lifetime. Only sqlite3_vfs/io_methods version 1 (no WAL).
import type { SqlcipherWasmModule } from "../crypto/sqlcipherLoader";

const SQLITE_OK = 0;
const SQLITE_IOERR_SHORT_READ = 522;
const SQLITE_NOTFOUND = 12;
const SQLITE_OPEN_DELETEONCLOSE = 0x00000008;
const SQLITE_ACCESS_EXISTS = 0;

interface FileEntry {
  bytes: Uint8Array;
}
interface OpenFile {
  name: string;
  deleteOnClose: boolean;
}

export interface JsVfs {
  name: string;
  files: Map<string, FileEntry>;
}

function resize(entry: FileEntry, newLen: number): void {
  if (newLen === entry.bytes.length) return;
  const next = new Uint8Array(newLen);
  next.set(entry.bytes.subarray(0, Math.min(entry.bytes.length, newLen)));
  entry.bytes = next;
}

export type OnWrite = (name: string, offset: number, data: Uint8Array) => void;

function makeIoMethods(mod: SqlcipherWasmModule, files: Map<string, FileEntry>, openFiles: Map<number, OpenFile>, onWrite?: OnWrite) {
  const fileEntry = (name: string): FileEntry => files.get(name) ?? (files.set(name, { bytes: new Uint8Array(0) }), files.get(name)!);

  return {
    xClose: (pFile: number) => {
      const of = openFiles.get(pFile);
      if (of) {
        if (of.deleteOnClose) files.delete(of.name);
        openFiles.delete(pFile);
      }
      return SQLITE_OK;
    },
    xRead: (pFile: number, pBuf: number, iAmt: number, iOfstBig: number | bigint) => {
      const entry = fileEntry(openFiles.get(pFile)!.name);
      const iOfst = Number(iOfstBig);
      const avail = entry.bytes.length - iOfst;
      if (avail <= 0) {
        mod.HEAPU8.fill(0, pBuf, pBuf + iAmt);
        return SQLITE_IOERR_SHORT_READ;
      }
      const n = Math.min(avail, iAmt);
      mod.HEAPU8.set(entry.bytes.subarray(iOfst, iOfst + n), pBuf);
      if (n < iAmt) {
        mod.HEAPU8.fill(0, pBuf + n, pBuf + iAmt);
        return SQLITE_IOERR_SHORT_READ;
      }
      return SQLITE_OK;
    },
    xWrite: (pFile: number, pBuf: number, iAmt: number, iOfstBig: number | bigint) => {
      const name = openFiles.get(pFile)!.name;
      const entry = fileEntry(name);
      const iOfst = Number(iOfstBig);
      if (iOfst + iAmt > entry.bytes.length) resize(entry, iOfst + iAmt);
      const data = mod.HEAPU8.subarray(pBuf, pBuf + iAmt);
      entry.bytes.set(data, iOfst);
      onWrite?.(name, iOfst, data.slice());
      return SQLITE_OK;
    },
    xTruncate: (pFile: number, sizeBig: number | bigint) => {
      resize(fileEntry(openFiles.get(pFile)!.name), Number(sizeBig));
      return SQLITE_OK;
    },
    xSync: () => SQLITE_OK,
    xFileSize: (pFile: number, pSize: number) => {
      const len = fileEntry(openFiles.get(pFile)!.name).bytes.length;
      mod.HEAP32[pSize >> 2] = len;
      mod.HEAP32[(pSize >> 2) + 1] = 0;
      return SQLITE_OK;
    },
    xLock: () => SQLITE_OK,
    xUnlock: () => SQLITE_OK,
    xCheckReservedLock: (_pFile: number, pResOut: number) => {
      mod.HEAP32[pResOut >> 2] = 0;
      return SQLITE_OK;
    },
    xFileControl: () => SQLITE_NOTFOUND,
    xSectorSize: () => 4096,
    xDeviceCharacteristics: () => 0,
  };
}

function makeVfsMethods(
  mod: SqlcipherWasmModule,
  files: Map<string, FileEntry>,
  openFiles: Map<number, OpenFile>,
  state: { ioMethodsPtr: number; tempCounter: number },
) {
  const fileEntry = (name: string): FileEntry => files.get(name) ?? (files.set(name, { bytes: new Uint8Array(0) }), files.get(name)!);

  return {
    xOpen: (_pVfs: number, zName: number, pFile: number, flags: number, pOutFlags: number) => {
      const fname = zName ? mod.UTF8ToString(zName) : `:jsvfs-temp-${state.tempCounter++}:`;
      fileEntry(fname);
      mod.HEAP32[pFile >> 2] = state.ioMethodsPtr;
      openFiles.set(pFile, { name: fname, deleteOnClose: !!(flags & SQLITE_OPEN_DELETEONCLOSE) });
      if (pOutFlags) mod.HEAP32[pOutFlags >> 2] = flags;
      return SQLITE_OK;
    },
    xDelete: (_pVfs: number, zName: number) => {
      files.delete(mod.UTF8ToString(zName));
      return SQLITE_OK;
    },
    xAccess: (_pVfs: number, zName: number, flags: number, pResOut: number) => {
      const exists = files.has(mod.UTF8ToString(zName));
      mod.HEAP32[pResOut >> 2] = flags === SQLITE_ACCESS_EXISTS ? (exists ? 1 : 0) : 1;
      return SQLITE_OK;
    },
    xFullPathname: (_pVfs: number, zName: number, nOut: number, zOut: number) => {
      mod.stringToUTF8(mod.UTF8ToString(zName), zOut, nOut);
      return SQLITE_OK;
    },
    xRandomness: (_pVfs: number, nByte: number, zOut: number) => {
      const bytes = new Uint8Array(nByte);
      for (let off = 0; off < nByte; ) {
        const chunk = bytes.subarray(off, Math.min(off + 65536, nByte));
        crypto.getRandomValues(chunk);
        off += chunk.length;
      }
      mod.HEAPU8.set(bytes, zOut);
      return nByte;
    },
    xSleep: (_pVfs: number, microseconds: number) => microseconds,
    xCurrentTime: (_pVfs: number, pTimeOut: number) => {
      mod.HEAPF64[pTimeOut >> 3] = 2440587.5 + Date.now() / 86400000;
      return SQLITE_OK;
    },
    xGetLastError: (_pVfs: number, nBuf: number, zBuf: number) => {
      if (nBuf > 0) mod.HEAPU8[zBuf] = 0;
      return SQLITE_OK;
    },
  };
}

// Each real method's parameters are all plain numbers except xRead/xWrite/
// xTruncate's own offset/size (number | bigint, handled internally via
// Number()) -- this cast just tells TS "call with exactly this many args",
// which is all addFunction's signature string already guarantees at runtime.
type VfsMethod = (...args: (number | bigint)[]) => number;
const as = (fn: (...args: never[]) => number): VfsMethod => fn as VfsMethod;

function methodSpecs(vfs: ReturnType<typeof makeVfsMethods>, io: ReturnType<typeof makeIoMethods>): Array<[VfsMethod, string]> {
  return [
    [as(vfs.xOpen), "iiiiii"],
    [as(vfs.xDelete), "iiii"],
    [as(vfs.xAccess), "iiiii"],
    [as(vfs.xFullPathname), "iiiii"],
    [as(vfs.xRandomness), "iiii"],
    [as(vfs.xSleep), "iii"],
    [as(vfs.xCurrentTime), "iii"],
    [as(vfs.xGetLastError), "iiii"],
    [as(io.xClose), "ii"],
    [as(io.xRead), "iiiij"],
    [as(io.xWrite), "iiiij"],
    [as(io.xTruncate), "iij"],
    [as(io.xSync), "iii"],
    [as(io.xFileSize), "iii"],
    [as(io.xLock), "iii"],
    [as(io.xUnlock), "iii"],
    [as(io.xCheckReservedLock), "iii"],
    [as(io.xFileControl), "iiii"],
    [as(io.xSectorSize), "ii"],
    [as(io.xDeviceCharacteristics), "ii"],
  ];
}

/** szOsFile: only pMethods (one pointer) lives in wasm memory -- everything
 * else is tracked JS-side in openFiles, keyed by the pFile pointer address. */
const SZ_OS_FILE = 4;
const MX_PATHNAME = 512;

export function registerJsVfs(mod: SqlcipherWasmModule, name = "jsvfs", makeDefault = false, onWrite?: OnWrite): JsVfs {
  const files = new Map<string, FileEntry>();
  const openFiles = new Map<number, OpenFile>();
  const state = { ioMethodsPtr: 0, tempCounter: 0 };
  const io = makeIoMethods(mod, files, openFiles, onWrite);
  const vfs = makeVfsMethods(mod, files, openFiles, state);

  const methodPtrs = methodSpecs(vfs, io).map(([fn, sig]) => mod.addFunction(fn, sig));
  const ptrBuf = mod._malloc(methodPtrs.length * 4);
  methodPtrs.forEach((ptr, i) => mod.setValue(ptrBuf + i * 4, ptr, "i32"));

  const nameLen = mod.lengthBytesUTF8(name);
  const namePtr = mod._malloc(nameLen + 1);
  mod.stringToUTF8(name, namePtr, nameLen + 1);

  const rc = mod._sqlite3_js_vfs_register(namePtr, SZ_OS_FILE, MX_PATHNAME, makeDefault ? 1 : 0, ptrBuf);
  mod._free(namePtr);
  mod._free(ptrBuf);
  if (rc !== SQLITE_OK) throw new Error(`sqlite3_js_vfs_register('${name}') failed: rc=${rc}`);

  state.ioMethodsPtr = mod._sqlite3_js_vfs_io_methods();
  return { name, files };
}
