// Mints a short-lived, prefix-scoped, READ-ONLY R2 credential
// (docs/r2_credentials.md). The caller presents its current InstantDB
// session token plus the txt row id and already-decrypted prefix. Before
// minting anything, this Worker queries InstantDB as that exact caller:
// instant.perms.ts therefore decides whether the caller still owns the txt
// or has a current share grant, while txt.prefixHash proves that the supplied
// prefix is the one belonging to that authorized row.
//
// Authorization happens once per opened document, not once per part. The
// returned R2 credential is restricted to `${prefix}/` and
// "object-read-only"; the browser then fetches every encrypted part directly
// from R2. Part bodies never transit this Worker. Revoking a share prevents
// minting another credential, while a credential already issued before the
// revoke remains usable only until this file's short TTL expires.
//
// The parent access key in env is the admin's own static R2 credential and is
// never sent to a client. Ingest tooling continues to write with its own
// static credential directly; this endpoint only ever grants reads.
import { SignJWT } from "jose";

const INSTANT_API_ORIGIN = "https://api.instantdb.com";

// Comfortably covers reading one document's worth of parts, while bounding
// how long a credential minted just before share revocation remains useful.
// ui/src/screens/Reader/useReaderBook.ts renews shortly before expiry.
const TTL_SECONDS = 900;

interface R2CredsRequestBody {
  instantToken: string;
  txtId: string;
  prefix: string;
}

interface TemporaryCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAtMs: number;
}

interface InstantTxtQueryResult {
  txt?: Array<{ prefixHash?: unknown }>;
}

export async function handleR2Creds(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await parseBody(request);
  if (!body) return jsonError("invalid or incomplete JSON body", 400);

  let authorized: boolean;
  try {
    authorized = await isAuthorizedPrefix(env, body);
  } catch {
    return jsonError("authorization service unavailable", 502);
  }
  if (!authorized) return jsonError("document access denied", 403);

  const cred = await mintTemporaryCredential(env, body.prefix);
  return jsonResponse(cred, 200);
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
  const { instantToken, txtId, prefix } = d;
  if (
    typeof instantToken !== "string" ||
    instantToken.length === 0 ||
    typeof txtId !== "string" ||
    txtId.length === 0 ||
    typeof prefix !== "string" ||
    prefix.length === 0
  ) {
    return null;
  }
  return { instantToken, txtId, prefix };
}

/** Queries only the requested txt row while impersonating the caller. The
 * `As-Token` form intentionally omits an admin token: InstantDB applies the
 * ordinary `txt.view` rule, including current owner/share links, instead of
 * bypassing it. An absent row is indistinguishable from a denied row here.
 * The Worker hashes the supplied prefix itself; clients never get to submit
 * the commitment they want compared. */
async function isAuthorizedPrefix(
  env: Env,
  body: R2CredsRequestBody,
): Promise<boolean> {
  const response = await fetch(
    `${INSTANT_API_ORIGIN}/admin/query?app_id=${encodeURIComponent(env.INSTANT_APP_ID)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "app-id": env.INSTANT_APP_ID,
        "as-token": body.instantToken,
      },
      body: JSON.stringify({
        query: {
          txt: {
            $: {
              where: { id: body.txtId },
              fields: ["prefixHash"],
            },
          },
        },
      }),
    },
  );

  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) {
    throw new Error(`InstantDB query failed with HTTP ${response.status}`);
  }

  const result = (await response.json()) as InstantTxtQueryResult;
  const prefixHash = result.txt?.[0]?.prefixHash;
  return (
    typeof prefixHash === "string" &&
    prefixHash === (await sha256Hex(body.prefix))
  );
}

// R2's local-signing Temporary Credentials path. The JWT is signed with the
// parent R2 secret without an outbound Cloudflare API call. `scope` is always
// object-read-only and prefixPaths contains exactly the already-authorized
// document prefix. The parent key id is reused as the temporary access key;
// R2 derives verification from the JWT session token and its digest.
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}
