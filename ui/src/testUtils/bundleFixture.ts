// Builds a bundle byte buffer independently of bundleFormat.ts's own
// parsing code, following txt/bundle.py's struct.pack layout directly
// (docs/data_model.md §6.3) -- a round trip against this is a check on
// parseBundle's byte-offset arithmetic, not a tautology mirroring it.
const HEADER_LEN = 114; // 4s H I 7*Q 3*16s = 4+2+4+56+48
const MAP_ENTRY_LEN = 12; // I Q
const INDEX_ENTRY_LEN = 24; // I Q Q I

export interface FixtureHotPage {
  pageNo: number;
  versionCreated: number;
  data: Uint8Array;
}

export function buildBundleFixture(builtAtVersion: number, pageMap: Array<[number, number]>, hotPages: FixtureHotPage[]): Uint8Array {
  const mapBytes = new Uint8Array(pageMap.length * MAP_ENTRY_LEN);
  const mapView = new DataView(mapBytes.buffer);
  pageMap.forEach(([pageNo, versionCreated], i) => {
    mapView.setUint32(i * MAP_ENTRY_LEN, pageNo, true);
    mapView.setBigUint64(i * MAP_ENTRY_LEN + 4, BigInt(versionCreated), true);
  });

  const hotBytes = new Uint8Array(hotPages.reduce((n, p) => n + p.data.length, 0));
  const indexBytes = new Uint8Array(hotPages.length * INDEX_ENTRY_LEN);
  const indexView = new DataView(indexBytes.buffer);
  let offset = 0;
  for (const [i, page] of hotPages.entries()) {
    hotBytes.set(page.data, offset);
    indexView.setUint32(i * INDEX_ENTRY_LEN, page.pageNo, true);
    indexView.setBigUint64(i * INDEX_ENTRY_LEN + 4, BigInt(page.versionCreated), true);
    indexView.setBigUint64(i * INDEX_ENTRY_LEN + 12, BigInt(offset), true);
    indexView.setUint32(i * INDEX_ENTRY_LEN + 20, page.data.length, true);
    offset += page.data.length;
  }

  const mapOff = HEADER_LEN;
  const hotOff = mapOff + mapBytes.length;
  const indexOff = hotOff + hotBytes.length;

  const header = new Uint8Array(HEADER_LEN);
  const headerView = new DataView(header.buffer);
  header.set(new TextEncoder().encode("TXBN"), 0);
  headerView.setUint16(4, 1, true);
  headerView.setUint32(6, 32768, true);
  headerView.setBigUint64(10, BigInt(builtAtVersion), true);
  headerView.setBigUint64(18, BigInt(mapOff), true);
  headerView.setBigUint64(26, BigInt(mapBytes.length), true);
  headerView.setBigUint64(34, BigInt(hotOff), true);
  headerView.setBigUint64(42, BigInt(hotBytes.length), true);
  headerView.setBigUint64(50, BigInt(indexOff), true);
  headerView.setBigUint64(58, BigInt(indexBytes.length), true);
  // Bytes 66..114 are the three 16-byte checksums -- left zeroed; parseBundle
  // never reads them (see its own comment on why).

  const out = new Uint8Array(HEADER_LEN + mapBytes.length + hotBytes.length + indexBytes.length);
  out.set(header, 0);
  out.set(mapBytes, mapOff);
  out.set(hotBytes, hotOff);
  out.set(indexBytes, indexOff);
  return out;
}
