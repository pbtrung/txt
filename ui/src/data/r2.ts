// R2 (S3-compatible) object storage client, mirrors txt/r2.py's R2Client --
// but read-only (this UI never uploads/deletes), signed with aws4fetch
// (built for exactly this Workers/browser + R2 use case, no Node polyfills
// needed) instead of boto3.

import { AwsClient } from "aws4fetch";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetches one R2 object, retrying with backoff before giving up. */
export async function getObject(client: AwsClient, config: R2Config, key: string): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const response = await client.fetch(objectUrl(config, key));
      if (!response.ok) {
        throw new Error(`R2 GET ${key} failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`R2 GET ${key} failed after ${MAX_ATTEMPTS} attempt(s): ${String(lastError)}`);
}
