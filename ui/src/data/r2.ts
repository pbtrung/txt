// R2 (S3-compatible) object storage client, mirrors txt/r2.py's R2Client --
// but read-only (this UI never uploads/deletes), signed with aws4fetch
// (built for exactly this Workers/browser + R2 use case, no Node polyfills
// needed) instead of boto3.

import { AwsClient } from "aws4fetch";

import { isBrowser } from "../env";
import type { R2Config } from "./r2Config";

// get_async/put_async/delete_async retry on failure with exponential
// backoff before giving up (txt/r2.py's _RETRY_DELAYS/_MAX_ATTEMPTS).
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;

export function createR2Client(config: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: config.readOnlyAccessKeyId,
    secretAccessKey: config.readOnlySecretAccessKey,
    region: config.region,
    service: "s3",
  });
}

function objectUrl(config: R2Config, key: string): string {
  return `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${encodeURIComponent(key)}`;
}

// Under local_index.html (opened via file://), a header-signed GET
// (Authorization/x-amz-date/x-amz-content-sha256) is a "non-simple" CORS
// request needing a preflight OPTIONS -- and R2's CORS policy can't be
// configured to answer one for a file:// page's null origin. A query-
// string-signed ("presigned") URL instead, since it carries no custom
// headers at all, is a *simple* request that never triggers a preflight in
// the first place. Kept to a short expiry (unlike the normal header-signed
// path, anyone who captured this exact URL during that window could reuse
// it directly) -- see appRouter.ts's pickRouterComponent for the same
// protocol === "file:" detection used to pick MemoryRouter.
export const PRESIGNED_EXPIRY_SECONDS = 60;

export function shouldPresign(protocol: string): boolean {
  return protocol === "file:";
}

function presignedObjectUrl(config: R2Config, key: string): string {
  const url = new URL(objectUrl(config, key));
  url.searchParams.set("X-Amz-Expires", String(PRESIGNED_EXPIRY_SECONDS));
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A signed GET carries an Authorization/x-amz-date/x-amz-content-sha256
// header set, which makes it a "non-simple" cross-origin request -- the
// browser sends a CORS preflight (OPTIONS) before it, and R2 buckets ship
// with no CORS policy at all by default. When that preflight fails, every
// browser surfaces the exact same generic `TypeError: Failed to fetch` as
// a plain network error (deliberately indistinguishable from e.g. being
// offline, so a page can't probe cross-origin state) -- so this can only
// ever be a best-effort hint, not a certain diagnosis.
const CORS_HINT =
  "if this is happening in a browser, check that the R2 bucket's CORS policy allows GET from this page's " +
  "origin (Cloudflare R2 ships with no CORS policy by default, which fails exactly this way)";

/** Fetches one R2 object, retrying with backoff before giving up. */
export async function getObject(client: AwsClient, config: R2Config, key: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const response =
        typeof location !== "undefined" && shouldPresign(location.protocol)
          ? await client.fetch(presignedObjectUrl(config, key), { aws: { signQuery: true } })
          : await client.fetch(objectUrl(config, key));
      if (!response.ok) {
        throw new Error(`R2 GET ${key} failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  const hint = isBrowser() && lastError instanceof TypeError ? ` (${CORS_HINT})` : "";
  throw new Error(`R2 GET ${key} failed after ${MAX_ATTEMPTS} attempt(s): ${String(lastError)}${hint}`);
}
