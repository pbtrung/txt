// Mints a short-lived, prefix-scoped R2 credential (docs/data_model.md's
// "Temporary, prefix-scoped R2 credentials" section) -- the only thing
// standing between a Firebase-signed identity and R2 access, for every
// account, admin included (env.READ_WRITE_ACCESS_KEY_ID/SECRET is the
// admin's own static R2 credential, held only as a Worker secret -- never
// sent to any client).
//
// Request body: { idToken, prefix, bucket }. This Worker's only job is
// verifying that idToken is a genuine, non-expired Firebase ID token for
// this app's own Firebase project (RS256 signature against Google's public
// JWKS via jose -- no outbound call to InstantDB at all, unlike an earlier
// draft of this file) and, if so, minting a credential scoped to exactly
// the requested prefix. It does NOT cross-check that the token's own
// subject actually owns that prefix -- prefix is trusted as given once the
// token itself is proven real, same as the client already trusts its own
// computeR2Prefix(authId) call. That means any Firebase-authenticated user
// of this app (i.e. anyone the admin has created an account for) could in
// principle request creds for a prefix that isn't their own; accepted here
// as a deliberate simplification for a small, admin-curated user base, not
// an oversight.
import { createRemoteJWKSet, jwtVerify } from "jose";

// The fixed endpoint Firebase ID tokens are verified against -- distinct
// from Google's general OAuth JWKS, specific to securetoken's signing keys.
// createRemoteJWKSet caches the fetched keys itself (in-memory, for this
// isolate's lifetime), so this only ever costs a real fetch on a cold start
// or a kid the cache hasn't seen yet.
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

// Comfortably covers one unlock session's worth of page fetches/commits
// (docs/data_model.md's read/commit protocols) -- short enough that a
// leaked credential stops working quickly, long enough that a normal
// session never needs more than one. dbWorkerClient.ts re-requests a fresh
// credential once this one expires; nothing caches it beyond that.
const TTL_SECONDS = 900;

interface R2CredsRequestBody {
  idToken: string;
  prefix: string;
  bucket: string;
}

interface TemporaryCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAtMs: number;
}

export async function handleR2Creds(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return jsonError("invalid or incomplete JSON body", 400);

  const verified = await verifyFirebaseIdToken(
    body.idToken,
    env.FIREBASE_PROJECT_ID,
  );
  if (!verified) {
    return jsonError("idToken is not a valid Firebase ID token", 401);
  }

  const cred = await mintTemporaryCredential(env, body.bucket, body.prefix);
  return new Response(JSON.stringify(cred), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function parseBody(request: Request): Promise<R2CredsRequestBody | null> {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const { idToken, prefix, bucket } = d;
  if (
    typeof idToken !== "string" ||
    typeof prefix !== "string" ||
    typeof bucket !== "string"
  ) {
    return null;
  }
  return { idToken, prefix, bucket };
}

// RS256 signature check against Firebase's own public JWKS, plus the
// standard Firebase ID token issuer/audience claims
// (https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library)
// -- issuer/audience are pinned to env.FIREBASE_PROJECT_ID (a Worker var,
// never client-supplied): accepting either from the request itself would
// let a caller point verification at a *different* Firebase project they
// control, defeating the check entirely.
async function verifyFirebaseIdToken(
  idToken: string,
  firebaseProjectId: string,
): Promise<boolean> {
  try {
    await jwtVerify(idToken, FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${firebaseProjectId}`,
      audience: firebaseProjectId,
    });
    return true;
  } catch {
    return false;
  }
}

// R2's "local signing" path for Temporary Credentials
// (https://developers.cloudflare.com/r2/api/s3/temporary-credentials/):
// no outbound call to Cloudflare's own API, just an HS256 JWT signed with
// the admin's parent R2 secret access key (held only as a Worker secret).
// The parent access key ID is reused as-is for the temporary credential;
// the temporary secretAccessKey is the SHA-256 hex digest of the signed
// JWT, and the sessionToken is base64url("jwt/" + <signed JWT>) -- R2
// derives the same values server-side from the accessKeyId (which tells it
// which parent secret to re-verify the signature against) on every request
// that carries them. Must be base64URL, not plain base64: standard btoa()
// output (with +//'s and '=' padding) got rejected outright with R2's own
// `<Error><Code>InvalidArgument</Code><Message>X-Amz-Security-Token
// </Message></Error>` (confirmed live, not documented anywhere -- the
// upstream docs just say "base64", which in JWT-adjacent contexts commonly
// means base64url).
async function mintTemporaryCredential(
  env: Env,
  bucket: string,
  prefix: string,
): Promise<TemporaryCredential> {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    bucket,
    // "scope" here, not "permission" -- "permission" is the equivalent
    // parameter name for Cloudflare's separate Temporary Credentials *API*
    // (the outbound-call alternative this Worker deliberately doesn't use),
    // not the local-signing JWT payload's own field name.
    scope: "object-read-write",
    paths: { prefixPaths: [`${prefix}/`] },
    ttlSeconds: TTL_SECONDS,
    iat,
  };
  const jwt = await signHs256Jwt(payload, env.READ_WRITE_SECRET_ACCESS_KEY);
  return {
    accessKeyId: env.READ_WRITE_ACCESS_KEY_ID,
    secretAccessKey: await sha256Hex(jwt),
    sessionToken: base64Url(new TextEncoder().encode(`jwt/${jwt}`)),
    expiresAtMs: (iat + TTL_SECONDS) * 1000,
  };
}

async function signHs256Jwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput =
    `${base64Url(encoder.encode(JSON.stringify(header)))}.` +
    base64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
