// Plain commitment stored as txt.prefixHash. Both the maintenance backfill
// and every new document write use this helper so they cannot drift on text
// encoding or digest representation. The Worker implements the same
// SHA-256(UTF-8(prefix)) -> padded Base64 operation with Web Crypto.
import { createHash } from "node:crypto";

export function computePrefixHash(prefix: string): string {
  return createHash("sha256").update(prefix, "utf8").digest("base64");
}
