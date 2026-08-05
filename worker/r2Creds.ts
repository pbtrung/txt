// Mints a short-lived, prefix-scoped, READ-ONLY R2 credential
// (docs/data_model.md's "Temporary, prefix-scoped R2 credentials"
// section) -- the only thing standing between a Firebase-signed identity
// and R2 access, for every account, admin included
// (env.READ_WRITE_ACCESS_KEY_ID/SECRET is the admin's own static R2
// credential, held only as a Worker secret -- never sent to any client).
//
// This endpoint is for the frontend (ui/) only, and every credential it
// mints is read-only ("object-read-only"), regardless of whether the verified
// identity is the admin or a `user`-role account -- the frontend never
// writes to R2 through this Worker. Writing (ingesting a new document's
// txtParts) is an admin-tooling operation that uses the admin's own real,
// static R2 credential directly (recoverable from the admin's own
// credStore row, docs/data_model.md's credStore entity), not a
// Worker-minted temporary one.
//
// Request body: { idToken, prefix }. This Worker's only
// job is verifying that idToken is a genuine, non-expired Firebase ID token
// for this app's own Firebase project (RS256 signature against Google's
// public JWKS via jose -- no outbound call to InstantDB at all, unlike an
// earlier draft of this file) and, if so, minting a read-only credential
// scoped to exactly the requested prefix in env.R2_BUCKET at env.R2_ENDPOINT.
// It does NOT cross-check that the token's own subject actually owns that
// prefix -- this Worker intentionally never talks to InstantDB. The simple
// design treats possession of a decrypted txt.prefix as a bearer read
// capability for R2 ciphertext access. A leaked prefix can let any verified
// caller fetch encrypted objects under that prefix until the prefix is
// rotated, but it does not grant write access and does not by itself decrypt
// document text.
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";

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

// Comfortably covers reading one document's worth of parts (docs/protocols.md's
// Read path) -- short enough that a leaked credential stops working quickly,
// long enough that a normal reading session never needs more than one per
// document. ui/src/screens/Reader/useReaderBook.ts (via tempR2Creds.ts)
// requests a fresh one once this one is close to expiring; nothing caches
// it beyond that.
const TTL_SECONDS = 900;

interface R2CredsRequestBody {
  idToken: string;
  prefix: string;
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

  const cred = await mintTemporaryCredential(env, body.prefix);
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
  const { idToken, prefix } = d;
  if (typeof idToken !== "string" || typeof prefix !== "string") {
    return null;
  }
  return { idToken, prefix };
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
// (https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/,
// which has actual runnable code, unlike
// developers.cloudflare.com/r2/api/s3/temporary-credentials/'s prose-only
// description -- an earlier version of this function was reverse-engineered
// from the latter and got several things wrong, confirmed live against a
// real R2 bucket: the claim is "scope", not "permission" ("permission" is
// the separate Temporary Credentials *API*'s own parameter name, not this
// JWT's field); there's no "ttlSeconds" claim at all -- expiry is the JWT's
// own standard "exp", set via setExpirationTime; and the JWT needs
// "sub"/"iss"/"aud" claims this Worker wasn't setting (subject = the R2
// account ID, issuer = the parent access key ID, audience = the R2
// endpoint's own host) -- R2 uses "iss" (not the request's own accessKeyId)
// to look up which parent secret to re-verify the HS256 signature against.
// No outbound call to Cloudflare's own API either way: this is pure local
// signing with the admin's parent R2 secret access key (held only as a
// Worker secret). The parent access key ID is reused as-is for the
// temporary credential; the temporary secretAccessKey is the SHA-256 hex
// digest of the signed JWT; the sessionToken is plain base64("jwt/" +
// <signed JWT>) (confirmed against the runnable example -- not base64url,
// despite an earlier guess to the contrary). `scope` is always
// "object-read-only" -- this Worker never mints a write-capable credential
// for any identity; see this file's top comment for why.
async function mintTemporaryCredential(
  env: Env,
  prefix: string,
): Promise<TemporaryCredential> {
  const endpointUrl = new URL(env.R2_ENDPOINT);
  const accountId = endpointUrl.hostname.split(".")[0];
  const jwt = await new SignJWT({
    bucket: env.R2_BUCKET,
    scope: "object-read-only",
    paths: { prefixPaths: [`${prefix}/`] },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(accountId)
    .setIssuer(env.READ_WRITE_ACCESS_KEY_ID)
    .setAudience(endpointUrl.host)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(env.READ_WRITE_SECRET_ACCESS_KEY));

  return {
    accessKeyId: env.READ_WRITE_ACCESS_KEY_ID,
    secretAccessKey: await sha256Hex(jwt),
    sessionToken: btoa(`jwt/${jwt}`),
    expiresAtMs: Date.now() + TTL_SECONDS * 1000,
  };
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
