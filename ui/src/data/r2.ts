// R2 (S3-compatible) object storage client, mirrors txt/r2.py's R2Client --
// signed with aws4fetch (built for exactly this Workers/browser + R2 use
// case, no Node polyfills needed) instead of boto3. Every regular-user
// session is read-only in practice (their r2_config row only ever holds the
// read-only pair), but the client itself isn't hardcoded that way: an admin
// session whose r2_config carries read-write keys (via txt.py
// --update-r2-config, see docs/credentials.md) gets a write-capable client
// here, which the admin Manage screen's txt delete/metadata edit rely on.

import { AwsClient } from "aws4fetch";

import { isBrowser } from "../env";
import type { R2Config } from "./r2Config";

// get_async/put_async/delete_async retry on failure with exponential
// backoff before giving up (txt/r2.py's _RETRY_DELAYS/_MAX_ATTEMPTS).
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;

/** Builds a client from this account's read-write keys if its r2_config
 * carries them (the admin's own row, post --update-r2-config), otherwise
 * the read-only pair every account's row has from the start. */
export function createR2Client(config: R2Config): AwsClient {
  const canWrite = Boolean(config.readWriteAccessKeyId && config.readWriteSecretAccessKey);
  return new AwsClient({
    accessKeyId: canWrite ? config.readWriteAccessKeyId! : config.readOnlyAccessKeyId,
    secretAccessKey: canWrite ? config.readWriteSecretAccessKey! : config.readOnlySecretAccessKey,
    region: config.region,
    service: "s3",
  });
}

function objectUrl(config: R2Config, key: string): string {
  return `${config.endpoint.replace(/\/+$/, "")}/${config.bucket}/${encodeURIComponent(key)}`;
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

async function withRetries(what: string, run: () => Promise<Response>): Promise<Response> {
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
  const hint = isBrowser() && lastError instanceof TypeError ? ` (${CORS_HINT})` : "";
  throw new Error(`${what} failed after ${MAX_ATTEMPTS} attempt(s): ${String(lastError)}${hint}`);
}

/** Fetches one R2 object, retrying with backoff before giving up. */
export async function getObject(
  client: AwsClient,
  config: R2Config,
  key: string,
): Promise<Uint8Array> {
  const response = await withRetries(`R2 GET ${key}`, () => client.fetch(objectUrl(config, key)));
  return new Uint8Array(await response.arrayBuffer());
}

/** Uploads one R2 object (overwriting it if it already exists), retrying
 * with backoff before giving up. Requires a write-capable client (see
 * createR2Client) -- an R2 bucket policy that only grants a read-only key
 * pair GET/HEAD/LIST rejects this regardless of what this function does. */
export async function putObject(
  client: AwsClient,
  config: R2Config,
  key: string,
  body: Uint8Array,
): Promise<void> {
  await withRetries(`R2 PUT ${key}`, () =>
    client.fetch(objectUrl(config, key), { method: "PUT", body: body as BodyInit }),
  );
}

/** Deletes one R2 object, retrying with backoff before giving up. Same
 * write-capable-client requirement as putObject. */
export async function deleteObject(
  client: AwsClient,
  config: R2Config,
  key: string,
): Promise<void> {
  await withRetries(`R2 DELETE ${key}`, () =>
    client.fetch(objectUrl(config, key), { method: "DELETE" }),
  );
}
