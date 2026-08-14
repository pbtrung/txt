// Orchestrates docs/data_model.md §6.1's open sequence for the Reader
// screen: seed the page map from the session's already-fetched bundle (or
// a full scan if there's none yet -- a brand new account with nothing
// ingested), apply the AA delta, fetch whichever pages the bundle's
// hot-pages section didn't already provide at their *current* version, and
// open BB keyed with db_master_key.
import { fromBase64 } from "../util/base64";
import { openBB, type BBEngine } from "./bbEngine";
import { hotPageKey, parseBundle } from "./bundleFormat";
import { fetchBundleDelta, fetchPageBytes, pinSnapshot, readHeadVersion, scanLivePages } from "./pageVersions";
import type { Aa } from "./session";

export interface ReaderSessionInput {
  aa: Aa;
  dbMasterKeyBase64: string;
  bundleBytes: Uint8Array | null;
}

function applyDelta(pageMap: Map<number, number>, delta: Map<number, number | null>): void {
  for (const [pageNo, versionCreated] of delta) {
    if (versionCreated === null) pageMap.delete(pageNo);
    else pageMap.set(pageNo, versionCreated);
  }
}

async function resolvePageMap(
  aa: Aa,
  bundleBytes: Uint8Array | null,
  headVersion: number,
): Promise<{ pageMap: Map<number, number>; hotPageBytes: Map<string, Uint8Array> }> {
  if (!bundleBytes) return { pageMap: await scanLivePages(aa), hotPageBytes: new Map() };
  const bundle = parseBundle(bundleBytes);
  const pageMap = new Map(bundle.pageMap);
  applyDelta(pageMap, await fetchBundleDelta(aa, bundle.builtAtVersion, headVersion));
  return { pageMap, hotPageBytes: bundle.hotPageBytes };
}

/** Pages the bundle's hot-pages section doesn't cover at their exact
 * current (page_no, version_created) -- either never hot, or hot at a now-
 * superseded version -- and so must come straight from AA. */
function missingPages(pageMap: Map<number, number>, hotPageBytes: Map<string, Uint8Array>): Array<[number, number]> {
  const missing: Array<[number, number]> = [];
  for (const [pageNo, versionCreated] of pageMap) {
    if (!hotPageBytes.has(hotPageKey(pageNo, versionCreated))) missing.push([pageNo, versionCreated]);
  }
  return missing;
}

function assemblePages(pageMap: Map<number, number>, hotPageBytes: Map<string, Uint8Array>, fetched: Map<number, Uint8Array>): Map<number, Uint8Array> {
  const pages = new Map<number, Uint8Array>();
  for (const [pageNo, versionCreated] of pageMap) {
    const hot = hotPageBytes.get(hotPageKey(pageNo, versionCreated));
    pages.set(pageNo, hot ?? fetched.get(pageNo)!);
  }
  return pages;
}

export async function openReaderBB(input: ReaderSessionInput): Promise<BBEngine> {
  const { version: headVersion } = await readHeadVersion(input.aa);
  await pinSnapshot(input.aa, headVersion);
  const { pageMap, hotPageBytes } = await resolvePageMap(input.aa, input.bundleBytes, headVersion);
  const fetched = await fetchPageBytes(input.aa, missingPages(pageMap, hotPageBytes));
  const pages = assemblePages(pageMap, hotPageBytes, fetched);
  return openBB(fromBase64(input.dbMasterKeyBase64), pages);
}
