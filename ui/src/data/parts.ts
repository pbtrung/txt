// Fetches and decodes one txt part, mirrors txt/download.py's _fetch_part --
// deliberately one part at a time (not the CLI's whole-document
// concatenation), for Reader pagination.
//
// Note the two-step decompression: txt/ingest.py brotli-compresses a part's
// cleaned text *before* calling Blob.encrypt (with compressed left at its
// default false), so Blob.decrypt here must also leave compressed=false and
// the caller brotli-decompresses the result manually -- unlike
// txt_metadata.content/txt_access.access/bookmarks.bookmark, which pass
// compressed=true to Blob itself. Getting this backwards silently corrupts
// (or fails to decode) every part's text.

import type { AwsClient } from "aws4fetch";

import * as blob from "../crypto/blob";
import * as brotli from "../crypto/brotli";
import { getObject } from "./r2";
import type { R2Config } from "./r2Config";

export async function fetchPart(
  r2Client: AwsClient,
  r2Config: R2Config,
  txtKey: Uint8Array,
  rawPath: string,
): Promise<string> {
  const body = await getObject(r2Client, r2Config, rawPath);
  const compressed = await blob.decrypt(txtKey, body, false);
  const cleaned = await brotli.decompress(compressed);
  return new TextDecoder().decode(cleaned);
}
