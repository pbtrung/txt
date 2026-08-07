// R2 (S3-compatible) object GET, mirrors txt/r2.ts's own R2Client -- signed
// with aws4fetch (built for exactly this Workers/browser + R2 use case, no
// Node polyfills needed) instead of the AWS SDK. Nothing here ever builds a
// client from a static key: every AwsClient this app uses comes from
// tempR2Creds.ts's short-lived, prefix-scoped temporary credential instead
// (docs/r2_credentials.md), for every account, admin included. GET-only:
// only the CLI (txt.ts --ingest) ever writes a txtParts object to R2, using
// the admin's own real, static credential directly, never through this
// module or the Worker-brokered temporary credential this file's own
// getObject always uses -- see docs/protocols.md's Ingest/write path.

import type { AwsClient } from "aws4fetch";

import { isBrowser } from "../env";
import type { R2Config } from "./r2Config";

// Retries on failure with exponential backoff before giving up (mirrors
// txt/r2.ts's own _RETRY_DELAYS/_MAX_ATTEMPTS).
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;

// Every part object's real key is "${prefix}/${rawKey}" (docs/protocols.md's
// Read path) -- encodeURIComponent on the whole string would turn that
// internal "/" into "%2F", which R2 (like S3) treats as part of a single
// path segment rather than the key's own real path separator, producing a
// 400 for what looks like a well-formed request otherwise. Each segment gets
// encoded on its own instead, joined back with literal "/"s.
function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function objectUrl(config: R2Config, key: string): string {
  return `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${encodeObjectKey(key)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A signed request carries an Authorization/x-amz-date/x-amz-content-sha256
// header set, which makes it a "non-simple" cross-origin request -- the
// browser sends a CORS preflight (OPTIONS) before it, and R2 buckets ship
// with no CORS policy at all by default. When that preflight fails, every
// browser surfaces the exact same generic `TypeError: Failed to fetch` as
// a plain network error (deliberately indistinguishable from e.g. being
// offline, so a page can't probe cross-origin state) -- so this can only
// ever be a best-effort hint, not a certain diagnosis.
const CORS_HINT =
  "if this is happening in a browser, check that the R2 bucket's CORS policy allows this method from this page's " +
  "origin (Cloudflare R2 ships with no CORS policy by default, which fails exactly this way)";

async function withRetries(
  what: string,
  run: () => Promise<Response>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const response = await run();
      if (!response.ok) {
        throw new Error(`${what} failed: HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      lastError = err;
    }
  }
  const hint =
    isBrowser() && lastError instanceof TypeError ? ` (${CORS_HINT})` : "";
  throw new Error(
    `${what} failed after ${MAX_ATTEMPTS} attempt(s): ${String(lastError)}${hint}`,
  );
}

/** Fetches one R2 object, retrying with backoff before giving up. */
export async function getObject(
  client: AwsClient,
  config: R2Config,
  key: string,
): Promise<Uint8Array> {
  const response = await withRetries(`R2 GET ${key}`, () =>
    client.fetch(objectUrl(config, key)),
  );
  return new Uint8Array(await response.arrayBuffer());
}
