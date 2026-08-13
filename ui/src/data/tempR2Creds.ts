// Calls this deployment's own Worker (worker/r2Creds.ts, same origin --
// it serves this app's static assets too, so no base URL/CORS setup is
// needed) to mint a short-lived, read-only R2 credential scoped to one
// document's own prefix (docs/data_model.md's txt.prefix, or sharedTxt.prefix
// for a share -- both random, wrapped under that row's own root key,
// unrelated to authId). This is the *only* way this app ever gets R2 *read*
// access, for every account, admin included -- see docs/r2_credentials.md.
// (The one exception, admin-only and write-only, is adminShares.ts's
// grantShare -- see r2.ts's buildAdminWriteClient.)
import { AwsClient } from "aws4fetch";
import type { LibraryDocKind } from "./library";
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

/** instantToken is the session token returned by InstantDB's own
 * signInWithIdToken call. The Worker presents it back to InstantDB via
 * As-Token so that entity's own normal view permission checks current
 * ownership before any R2 credential is minted.
 *
 * kind/id name which row this credential is for (a "txt" row for an owned
 * document, a "sharedTxt" row for a share); prefix is that row's own
 * already-decrypted prefix, not derived from authId -- a temporary
 * credential scopes to exactly one document at a time
 * (docs/r2_credentials.md), so a caller reading N different documents calls
 * this N times, once per document, rather than once per session. */
export async function fetchTempR2Credential(
  instantToken: string,
  kind: LibraryDocKind,
  id: string,
  prefix: string,
  r2Config: R2Config,
): Promise<TempR2Credential> {
  const resp = await fetch("/api/r2-creds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instantToken,
      kind,
      id,
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
