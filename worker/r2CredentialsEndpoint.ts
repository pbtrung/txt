// docs/storage_layout.md §"Credentials": mints R2 credentials for the
// browser (POST /v1/r2-credentials, below) and for the Worker's own
// presigned-URL minting (worker/sharedUrlEndpoint.ts) entirely locally,
// by signing a scoped JWT with the parent R2 token's own secret access
// key -- Cloudflare's documented client-side-signing scheme
// (https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/).
// R2 validates the embedded JWT's signature itself when the credential
// is actually used; minting needs no network call and no separate
// Cloudflare API token, unlike the account-level temp-access-credentials
// API this replaced.
import { SignJWT } from "jose";
import type { ProofContext } from "./requireProof";
import { requireVar } from "./requireVar";

const BROWSER_CREDENTIAL_TTL_SECONDS = 15 * 60;

type Permission = "object-read-write" | "object-read-only";

export interface MintCredentialScope {
  prefixes?: string[];
  objects?: string[];
}

export interface TempR2Credential {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
}

export type MintCredential = (
  permission: Permission,
  scope: MintCredentialScope,
  ttlSeconds: number,
) => Promise<TempR2Credential>;

interface R2ParentVars {
  accountId: string;
  parentAccessKeyId: string;
  parentSecretAccessKey: string;
  bucket: string;
}

function requireR2Vars(env: Env): R2ParentVars {
  return {
    accountId: requireVar(env.CF_ACCOUNT_ID, "CF_ACCOUNT_ID"),
    parentAccessKeyId: requireVar(
      env.R2_PARENT_ACCESS_KEY_ID,
      "R2_PARENT_ACCESS_KEY_ID",
    ),
    parentSecretAccessKey: requireVar(
      env.R2_PARENT_SECRET_ACCESS_KEY,
      "R2_PARENT_SECRET_ACCESS_KEY",
    ),
    bucket: requireVar(env.BUCKET_NAME, "BUCKET_NAME"),
  };
}

/** The real implementation. Injectable so tests can supply a fixed
 * parent key pair without needing a live Cloudflare account (mirrors
 * worker/access.ts's `fetchJwks` pattern). */
export function createMintCredential(env: Env): MintCredential {
  return (permission, scope, ttlSeconds) =>
    signTempCredential(env, permission, scope, ttlSeconds);
}

async function signTempCredential(
  env: Env,
  permission: Permission,
  scope: MintCredentialScope,
  ttlSeconds: number,
): Promise<TempR2Credential> {
  const vars = requireR2Vars(env);
  const jwt = await signScopedJwt({ ...vars, permission, scope, ttlSeconds });
  return {
    access_key_id: vars.parentAccessKeyId,
    secret_access_key: await sha256Hex(jwt),
    session_token: btoa(`jwt/${jwt}`),
  };
}

interface SignScopedJwtInput extends R2ParentVars {
  permission: Permission;
  scope: MintCredentialScope;
  ttlSeconds: number;
}

function buildJwtClaims(
  bucket: string,
  permission: Permission,
  scope: MintCredentialScope,
): Record<string, unknown> {
  const claims: Record<string, unknown> = { bucket, scope: permission };
  if (scope.prefixes || scope.objects) {
    claims.paths = {
      prefixPaths: scope.prefixes ?? [],
      objectPaths: scope.objects ?? [],
    };
  }
  return claims;
}

async function signScopedJwt(input: SignScopedJwtInput): Promise<string> {
  const claims = buildJwtClaims(input.bucket, input.permission, input.scope);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.accountId)
    .setIssuer(input.parentAccessKeyId)
    .setAudience(`${input.accountId}.r2.cloudflarestorage.com`)
    .setIssuedAt()
    .setExpirationTime(`${input.ttlSeconds}s`)
    .sign(new TextEncoder().encode(input.parentSecretAccessKey));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
      mintCredential(
        "object-read-write",
        { prefixes: [`${dbPrefix}/documents/`, `${dbPrefix}/shared/`] },
        BROWSER_CREDENTIAL_TTL_SECONDS,
      ),
      mintCredential(
        "object-read-only",
        { prefixes: [`${dbPrefix}/catalog/`] },
        BROWSER_CREDENTIAL_TTL_SECONDS,
      ),
    ]);
  } catch (error) {
    // Local signing has no network dependency left to fail -- this is
    // always a configuration problem (a missing/invalid secret) now, not
    // an upstream outage, hence 500 rather than the old 502. Server-side
    // only: log the real reason (`requireVar()` throws for a missing
    // secret exactly like it does for vars) so `wrangler tail` can see it.
    console.error(
      `POST /v1/r2-credentials: mintCredential failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Response("failed to mint R2 credentials", { status: 500 });
  }

  return Response.json({
    endpoint: `https://${requireVar(env.CF_ACCOUNT_ID, "CF_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    bucket: requireVar(env.BUCKET_NAME, "BUCKET_NAME"),
    expires_at: Math.floor(Date.now() / 1000) + BROWSER_CREDENTIAL_TTL_SECONDS,
    documents,
    catalog,
  });
}
