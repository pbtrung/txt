// Parses a bundle's plaintext bytes (already fetched + decrypted by
// bundle.ts) per txt/bundle.py's exact struct layout (docs/data_model.md
// §6.3): header, page map, hot pages, index. There is no existing reader
// to port this from -- txt/bundle.py only ever builds bundles, nothing in
// this codebase has read one back before -- so this is derived directly
// from BundleBuilder's own struct.pack calls, not ported logic.
//
// HEADER_FMT = "<4sHI" + "Q"*7 + "16s16s16s":
//   magic(4) version(u16) page_size(u32) built_at_version(u64)
//   map_off(u64) map_len(u64) hot_off(u64) hot_len(u64) index_off(u64) index_len(u64)
//   checksum_map(16) checksum_hot(16) checksum_index(16)
// Per-section blake2b checksums exist for internal consistency, not
// verified here -- the whole blob is already AEAD-authenticated by
// CryptoBlob before this ever runs, which is the actual integrity
// guarantee; verifying blake2b too would need a JS blake2b implementation
// for no additional security.
const MAGIC = "TXBN";
const HEADER_LEN = 4 + 2 + 4 + 7 * 8 + 3 * 16; // 114
const MAP_ENTRY_LEN = 4 + 8; // page_no(u32) version_created(u64)
const INDEX_ENTRY_LEN = 4 + 8 + 8 + 4; // page_no(u32) version_created(u64) offset(u64) length(u32)

export interface ParsedBundle {
  builtAtVersion: number;
  pageSize: number;
  pageMap: Map<number, number>;
  // Keyed by "pageNo:versionCreated", not pageNo alone: docs/data_model.md
  // §6.3 is explicit that the hot-page index is keyed this way so a bundle
  // of any age stays correct -- a page's cached bytes are only valid for
  // the exact version they were captured at, not for whatever version
  // page_map says that page number is at after the AA delta is applied.
  hotPageBytes: Map<string, Uint8Array>;
}

export function hotPageKey(pageNo: number, versionCreated: number): string {
  return `${pageNo}:${versionCreated}`;
}

function readHeader(view: DataView) {
  const magic = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, 4));
  if (magic !== MAGIC) throw new Error(`bad bundle magic: ${magic}`);
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported bundle format version: ${version}`);
  return {
    pageSize: view.getUint32(6, true),
    builtAtVersion: Number(view.getBigUint64(10, true)),
    mapOff: Number(view.getBigUint64(18, true)),
    mapLen: Number(view.getBigUint64(26, true)),
    hotOff: Number(view.getBigUint64(34, true)),
    hotLen: Number(view.getBigUint64(42, true)),
    indexOff: Number(view.getBigUint64(50, true)),
    indexLen: Number(view.getBigUint64(58, true)),
  };
}

function readPageMap(view: DataView, off: number, len: number): Map<number, number> {
  const map = new Map<number, number>();
  for (let pos = off; pos < off + len; pos += MAP_ENTRY_LEN) {
    map.set(view.getUint32(pos, true), Number(view.getBigUint64(pos + 4, true)));
  }
  return map;
}

function readHotPages(bytes: Uint8Array, view: DataView, hotOff: number, indexOff: number, indexLen: number): Map<string, Uint8Array> {
  const hotPageBytes = new Map<string, Uint8Array>();
  for (let pos = indexOff; pos < indexOff + indexLen; pos += INDEX_ENTRY_LEN) {
    const pageNo = view.getUint32(pos, true);
    const versionCreated = Number(view.getBigUint64(pos + 4, true));
    const offset = Number(view.getBigUint64(pos + 12, true));
    const length = view.getUint32(pos + 20, true);
    hotPageBytes.set(hotPageKey(pageNo, versionCreated), bytes.slice(hotOff + offset, hotOff + offset + length));
  }
  return hotPageBytes;
}

export function parseBundle(bytes: Uint8Array): ParsedBundle {
  if (bytes.length < HEADER_LEN) throw new Error(`bundle too short: ${bytes.length} < ${HEADER_LEN}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(view);
  return {
    builtAtVersion: header.builtAtVersion,
    pageSize: header.pageSize,
    pageMap: readPageMap(view, header.mapOff, header.mapLen),
    hotPageBytes: readHotPages(bytes, view, header.hotOff, header.indexOff, header.indexLen),
  };
}
