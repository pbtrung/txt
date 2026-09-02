// docs/storage_layout.md §"Credentials": mints two separate 15-minute R2
// credentials for the browser via Cloudflare's account-level R2
// temp-access-credentials API. This is a plain HTTP call to Cloudflare's
// control-plane API, not the Workers R2 binding -- R2Bucket has no method
// for minting scoped, temporary credentials at all (only direct
// get/put/delete/list from inside the Worker itself, which this design
// deliberately never uses for content). Requires ticket + proof
// (docs/auth.md §4.3), same as every other mutating endpoint.
import type { ProofContext } from "./requireProof";
import { requireVar } from "./requireVar";

const TTL_SECONDS = 15 * 60;

type Permission = "object-read-write" | "object-read-only";

export interface TempR2Credential {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
}

export type MintCredential = (
  permission: Permission,
  prefixes: string[],
) => Promise<TempR2Credential>;

interface TempCredentialsApiResponse {
  success: boolean;
  result?: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}

/** The real implementation, calling Cloudflare's API with the deployment's
 * parent R2 API token. Injectable so tests can supply a fixed response
 * without a live Cloudflare account (mirrors worker/access.ts's
 * `fetchJwks` pattern). */
export function createMintCredential(env: Env): MintCredential {
  return async (permission, prefixes) => {
    const accountId = requireVar(env.CF_ACCOUNT_ID, "CF_ACCOUNT_ID");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${requireVar(env.R2_PARENT_API_TOKEN, "R2_PARENT_API_TOKEN")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bucket: requireVar(env.BUCKET_NAME, "BUCKET_NAME"),
          parentAccessKeyId: requireVar(
            env.R2_PARENT_ACCESS_KEY_ID,
            "R2_PARENT_ACCESS_KEY_ID",
          ),
          permission,
          ttlSeconds: TTL_SECONDS,
          prefixes,
        }),
      },
    );
    const body = (await response.json()) as TempCredentialsApiResponse;
    if (!response.ok || !body.success || !body.result) {
      throw new Error(`R2 temp-access-credentials request failed: ${response.status}`);
    }
    return {
      access_key_id: body.result.accessKeyId,
      secret_access_key: body.result.secretAccessKey,
      session_token: body.result.sessionToken,
    };
  };
}

export async function handlePostR2Credentials(
  env: Env,
  proof: ProofContext,
  mintCredential: MintCredential = createMintCredential(env),
): Promise<Response> {
  const { dbPrefix } = proof;
  let documents: TempR2Credential;
  let catalog: TempR2Credential;
  try {
    [documents, catalog] = await Promise.all([
      mintCredential("object-read-write", [
        `${dbPrefix}/documents/`,
        `${dbPrefix}/shared/`,
      ]),
      mintCredential("object-read-only", [`${dbPrefix}/catalog/`]),
    ]);
  } catch {
    // The Cloudflare API call itself failed -- not a client error, so none
    // of docs/auth.md §4.2's client-facing statuses apply.
    return new Response("failed to mint R2 credentials", { status: 502 });
  }

  return Response.json({
    endpoint: `https://${requireVar(env.CF_ACCOUNT_ID, "CF_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket: requireVar(env.BUCKET_NAME, "BUCKET_NAME"),
    expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    documents,
    catalog,
  });
}
