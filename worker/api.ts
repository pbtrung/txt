// The /v1/* route table. Every route requires a verified Cloudflare Access
// session (docs/auth.md §1/§2) except the ones explicitly marked `public`
// -- today, only `POST /v1/shared-url` (docs/sharing.md). Access itself
// already blocks an unauthenticated request from ever reaching the Worker
// in production; the check here is the Worker's own defense-in-depth
// verification, not the primary gate. Routes marked `requiresProof` also
// need a verified ticket and proof of possession (docs/auth.md §4.2/§4.3)
// on top of that.
import { verifyAccessJwt } from "./access";
import type { AccessJwtClaims } from "./access";
import { handleGetOwner } from "./ownerEndpoint";
import { requireProof, ProofRequiredError } from "./requireProof";
import type { ProofContext } from "./requireProof";
import { handleGetDocuments, handlePatchDocumentAccess } from "./documentsEndpoint";
import {
  handleGetBookmarks,
  handlePostBookmark,
  handleDeleteBookmark,
} from "./bookmarksEndpoint";

export interface RequestContext {
  access: AccessJwtClaims | undefined;
  params: Record<string, string>;
  proof?: ProofContext;
}

type Handler = (
  request: Request,
  env: Env,
  ctx: RequestContext,
) => Promise<Response> | Response;

interface Route {
  handler: Handler;
  public?: boolean;
  requiresProof?: boolean;
}

const ROUTES: Record<string, Partial<Record<string, Route>>> = {
  "/v1/health": {
    GET: { handler: () => Response.json({ status: "ok" }) },
  },
  "/v1/owner": {
    // `ctx.access` is always defined here: this route isn't `public`, so
    // handleApi() has already verified it before invoking the handler.
    GET: { handler: (_request, env, ctx) => handleGetOwner(env, ctx.access!) },
  },
  "/v1/documents": {
    GET: { handler: (_request, env) => handleGetDocuments(env) },
  },
  "/v1/documents/:id/access": {
    PATCH: {
      requiresProof: true,
      handler: (_request, env, ctx) =>
        handlePatchDocumentAccess(env, ctx.params.id, ctx.proof!),
    },
  },
  "/v1/bookmarks": {
    GET: { handler: (request, env) => handleGetBookmarks(env, new URL(request.url)) },
    POST: {
      requiresProof: true,
      handler: (_request, env, ctx) => handlePostBookmark(env, ctx.proof!),
    },
  },
  "/v1/bookmarks/:id": {
    DELETE: {
      requiresProof: true,
      handler: (_request, env, ctx) => handleDeleteBookmark(env, ctx.params.id),
    },
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

// A route pattern's dynamic segments (e.g. "/v1/bookmarks/:id") are the
// only templating this app needs -- one param per segment, no wildcards.
function matchPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const pathParts = pathname.split("/");
  const patternParts = pattern.split("/");
  if (pathParts.length !== patternParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part.startsWith(":")) {
      params[part.slice(1)] = pathParts[i];
    } else if (part !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function findRoute(
  pathname: string,
): { methods: Partial<Record<string, Route>>; params: Record<string, string> } | null {
  for (const [pattern, methods] of Object.entries(ROUTES)) {
    const params = matchPattern(pathname, pattern);
    if (params) {
      return { methods, params };
    }
  }
  return null;
}

export async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const found = findRoute(url.pathname);
  if (!found) {
    return new Response("Not Found", { status: 404 });
  }
  const route = found.methods[request.method];
  if (!route) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let access: AccessJwtClaims | undefined;
  if (!route.public) {
    try {
      access = await requireAccess(request, env);
    } catch {
      // Deliberately uniform: which check failed isn't revealed to the
      // caller (docs/auth.md's Access session is either present and valid,
      // or the request doesn't get further than this).
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let proof: ProofContext | undefined;
  if (route.requiresProof) {
    try {
      proof = await requireProof(request, env, url);
    } catch (error) {
      if (error instanceof ProofRequiredError) {
        return new Response(error.message, { status: error.status });
      }
      throw error;
    }
  }

  return route.handler(request, env, { access, params: found.params, proof });
}
