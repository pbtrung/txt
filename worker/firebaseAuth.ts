// Verifies a Firebase ID token per docs/auth.md §5 step 1: RS256 signature
// against Google's own published signing keys for
// securetoken@system.gserviceaccount.com, cached for the lifetime the
// response's own Cache-Control max-age specifies. Asserts iss/aud/exp
// (jwtVerify's own job) plus iat/auth_time-not-in-the-future and a
// non-empty sub, exactly as docs/auth.md §5 step 1 lists them.

import { importX509, jwtVerify } from "jose";

const CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

interface CertCache {
  certs: Record<string, string>;
  expiresAtMs: number;
}

let cache: CertCache | null = null;

function parseMaxAgeSeconds(cacheControl: string | null): number {
  const match = cacheControl?.match(/max-age=(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function fetchCerts(): Promise<CertCache> {
  const resp = await fetch(CERTS_URL);
  if (!resp.ok) {
    throw new Error(`failed to fetch Firebase signing certs: ${resp.status}`);
  }
  const certs = (await resp.json()) as Record<string, string>;
  const maxAgeMs = parseMaxAgeSeconds(resp.headers.get("cache-control")) * 1000;
  return { certs, expiresAtMs: Date.now() + maxAgeMs };
}

async function getCerts(): Promise<Record<string, string>> {
  if (cache && Date.now() < cache.expiresAtMs) return cache.certs;
  cache = await fetchCerts();
  return cache.certs;
}

function decodeKeyId(idToken: string): string {
  const headerB64Url = idToken.split(".")[0];
  const headerJson = atob(headerB64Url.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(headerJson).kid;
}

function assertNotInFuture(value: unknown, label: string): void {
  const nowSeconds = Date.now() / 1000;
  if (typeof value === "number" && value > nowSeconds) {
    throw new Error(`${label} is in the future`);
  }
}

export interface VerifiedIdToken {
  uid: string;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
): Promise<VerifiedIdToken> {
  const certs = await getCerts();
  const cert = certs[decodeKeyId(idToken)];
  if (!cert) throw new Error("unknown signing key id");
  const key = await importX509(cert, "RS256");
  const { payload } = await jwtVerify(idToken, key, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  assertNotInFuture(payload.iat, "iat");
  assertNotInFuture(payload.auth_time, "auth_time");
  if (!payload.sub) throw new Error("missing sub claim");
  return { uid: payload.sub };
}

// Test-only: lets tests inject a cert map without a real network fetch,
// and reset the module-level cache between tests.
export function __setCertCacheForTests(certs: Record<string, string> | null): void {
  cache = certs ? { certs, expiresAtMs: Date.now() + 60_000 } : null;
}
