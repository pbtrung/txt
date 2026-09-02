// The /v1/* route table. Every route requires a verified Cloudflare Access
// session (docs/auth.md §1/§2) except the ones explicitly marked `public`
// -- today, only `POST /v1/shared-url` (docs/sharing.md). Access itself
// already blocks an unauthenticated request from ever reaching the Worker
// in production; the check here is the Worker's own defense-in-depth
// verification, not the primary gate.
import { verifyAccessJwt } from "./access";
import type { AccessJwtClaims } from "./access";

type Handler = (request: Request, env: Env, url: URL) => Promise<Response> | Response;

interface Route {
  handler: Handler;
  public?: boolean;
}

const ROUTES: Record<string, Partial<Record<string, Route>>> = {
  "/v1/health": {
    GET: { handler: () => Response.json({ status: "ok" }) },
  },
  // Placeholder: the real handler (docs/sharing.md §3.2) lands in
  // Milestone 7. Declared now, and marked public, so the Access-gating
  // rule ("every /v1/* route except this one") is concretely testable
  // rather than asserted about a route that doesn't exist yet.
  "/v1/shared-url": {
    POST: {
      public: true,
      handler: () => new Response("Not Implemented", { status: 501 }),
    },
  },
};

const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // Access's signing keys rotate infrequently.

let cachedJwks: { value: unknown; fetchedAt: number } | null = null;

async function fetchJwks(teamDomain: string): Promise<unknown> {
  if (cachedJwks && Date.now() - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cachedJwks.value;
  }
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`failed to fetch Access JWKS: ${response.status}`);
  }
  const value: unknown = await response.json();
  cachedJwks = { value, fetchedAt: Date.now() };
  return value;
}

// wrangler types infers each `vars` entry's type from its committed
// wrangler.jsonc placeholder value, as a narrow, optional string literal --
// not the general, always-present `string` these actually are once
// scripts/deploy.sh substitutes the real values. Reading through this
// (rather than a bare `as string`) also catches the genuine
// misconfiguration case: a deploy that forgot to substitute a placeholder.
function requireVar(value: string | undefined, name: string): string {
  if (!value || value.startsWith("replace-me-")) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

async function requireAccess(request: Request, env: Env): Promise<AccessJwtClaims> {
  const token = request.headers.get(ACCESS_HEADER);
  if (!token) {
    throw new Error("missing Access session");
  }
  const teamDomain = requireVar(env.CF_ACCESS_TEAM_DOMAIN, "CF_ACCESS_TEAM_DOMAIN");
  return verifyAccessJwt({
    token,
    fetchJwks: () => fetchJwks(teamDomain),
    audience: requireVar(env.CF_ACCESS_AUD, "CF_ACCESS_AUD"),
    issuer: `https://${teamDomain}`,
    ownerEmail: requireVar(env.OWNER_EMAIL, "OWNER_EMAIL"),
  });
}

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const routesForPath = ROUTES[url.pathname];
  if (!routesForPath) {
    return new Response("Not Found", { status: 404 });
  }
  const route = routesForPath[request.method];
  if (!route) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!route.public) {
    try {
      await requireAccess(request, env);
    } catch {
      // Deliberately uniform: which check failed isn't revealed to the
      // caller (docs/auth.md's Access session is either present and valid,
      // or the request doesn't get further than this).
      return new Response("Unauthorized", { status: 401 });
    }
  }

  return route.handler(request, env, url);
}
