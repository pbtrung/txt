// Calls this deployment's own Worker (worker/r2Creds.ts, same origin --
// it serves this app's static assets too, so no base URL/CORS setup is
// needed) to mint a short-lived, prefix-scoped R2 credential for the
// current session's own r2Prefix. This is the *only* way this app ever
// gets R2 access, for every account, admin included -- see
// docs/data_model.md's "Temporary, prefix-scoped R2 credentials" section.
import { AwsClient } from "aws4fetch";
import { computeR2Prefix } from "./pagePointer";
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
 * own signInWithIdToken call -- see this session's OpenParams.idToken.
 * Like that call, this one has no built-in retry for an idToken that's
 * gone stale since the session started; a 401 here surfaces as an
 * ordinary thrown error, same as any other stale-idToken failure. */
export async function fetchTempR2Credential(
  idToken: string,
  authId: string,
  r2Config: R2Config,
): Promise<TempR2Credential> {
  const resp = await fetch("/api/r2-creds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idToken,
      prefix: computeR2Prefix(authId),
      bucket: r2Config.bucket,
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
