// Orchestrates docs/data_model.md §8.4's client read path: compare AA's
// library_index row against the local cache before ever issuing a GET.
import { brotliDecompress } from "../crypto/brotli";
import { decrypt } from "../crypto/cryptoBlob";
import { bytesEqual, readCachedLibraryIndex, writeCachedLibraryIndex } from "./libraryIndexCache";
import type { R2 } from "./r2";
import type { Aa } from "./session";
import { readLibraryIndexKeys } from "./session";

export async function loadLibraryIndex(aa: Aa, umk: Uint8Array, dbPrefix: string, r2: R2): Promise<Uint8Array | null> {
  const keys = await readLibraryIndexKeys(aa, umk);
  if (!keys) return null;
  const cached = await readCachedLibraryIndex();
  if (cached && cached.builtAtVersion === keys.builtAtVersion && bytesEqual(cached.contentHash, keys.contentHash)) {
    return cached.bytes;
  }
  const encrypted = await r2.getObject(`${dbPrefix}/i/${keys.objectKey}`);
  const bytes = await brotliDecompress(await decrypt(encrypted, keys.libIdxKey));
  await writeCachedLibraryIndex({ builtAtVersion: keys.builtAtVersion, contentHash: keys.contentHash, bytes });
  return bytes;
}
