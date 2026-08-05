// Calls this deployment's own Worker (worker/r2Creds.ts, same origin --
// it serves this app's static assets too, so no base URL/CORS setup is
// needed) to mint a short-lived, read-only R2 credential scoped to one
// document's own prefix (docs/data_model.md's txt.prefix -- random,
// wrapped under that document's own txtKey, unrelated to authId). This is
// the *only* way this app ever gets R2 access, for every account, admin
// included -- see docs/r2_credentials.md.
import { AwsClient } from "aws4fetch";
import type { R2Config } from "./r2Config";

export interface TempR2Credential {
  client: AwsClient;
  expiresAtMs: number;
}

interface R2CredsResponse {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAtMs: number;
}

/** idToken is the same Firebase ID token already used for this session's
 * own signInWithIdToken call. This one has no built-in retry for an idToken
 * that's gone stale since the session started; a 401 here surfaces as an
 * ordinary thrown error, same as any other stale-idToken failure.
 *
 * prefix is a document's own already-decrypted txt.prefix, not derived from
 * authId -- a temporary credential scopes to exactly one document at a
 * time (docs/r2_credentials.md), so a caller reading N different documents
 * calls this N times, once per document, rather than once per session. */
export async function fetchTempR2Credential(
  idToken: string,
  prefix: string,
  r2Config: R2Config,
): Promise<TempR2Credential> {
  const resp = await fetch("/api/r2-creds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idToken,
      prefix,
    }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => null);
    const detail = body?.error ? `: ${body.error}` : "";
    throw new Error(`/api/r2-creds failed with HTTP ${resp.status}${detail}`);
  }
  const data = (await resp.json()) as R2CredsResponse;
  return {
    client: new AwsClient({
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
      sessionToken: data.sessionToken,
      region: r2Config.region,
      service: "s3",
    }),
    expiresAtMs: data.expiresAtMs,
  };
}
