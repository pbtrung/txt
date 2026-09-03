// Shared test-only helper for producing a validly-signed Access JWT and a
// matching JWKS, so integration tests (worker/tests/index.test.ts and
// others) can exercise real Access-gated routing through
// worker/api.ts's actual fetchJwks() call, rather than re-deriving this
// setup in every test file. worker/tests/access.test.ts deliberately keeps
// its own inline, more adversarial version of this (it needs to construct
// deliberately-invalid tokens this happy-path helper doesn't need to).
const KID = "test-key-id";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type JwkWithKid = JsonWebKey & { kid: string };

let keyPairPromise: Promise<CryptoKeyPair> | null = null;

function getKeyPair(): Promise<CryptoKeyPair> {
  keyPairPromise ??= crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
  return keyPairPromise;
}

/** The JWKS response worker/api.ts's fetchJwks() should be made to return
 * (via a mocked `fetch`) for a token from `signTestAccessToken` to verify. */
export async function testJwks(): Promise<{ keys: JwkWithKid[] }> {
  const { publicKey } = await getKeyPair();
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  return { keys: [{ ...jwk, kid: KID }] };
}

/** Signs a validly-shaped Access JWT for the given claims (typically
 * `{ email, aud: [aud], iss }` matching a test environment's
 * OWNER_EMAIL/CF_ACCESS_AUD/CF_ACCESS_TEAM_DOMAIN vars). */
export async function signTestAccessToken(
  claims: Record<string, unknown>,
): Promise<string> {
  const { privateKey } = await getKeyPair();
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Monkey-patches `globalThis.fetch` so a request to `.../cdn-cgi/access/certs`
 * resolves to `testJwks()`, and everything else falls through to the real
 * `fetch`. Returns a restore function -- call it in the same test (or an
 * `afterEach`) to avoid leaking the mock into other tests. */
export function mockAccessCertsEndpoint(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/cdn-cgi/access/certs")) {
      return Response.json(await testJwks());
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
