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
import {
  handleGetDocuments,
  handleGetDocument,
  handleGetDocumentContent,
  handlePatchDocumentAccess,
} from "./documentsEndpoint";
import { handleGetCatalog } from "./catalogEndpoint";
import {
  handleGetBookmarks,
  handleGetBookmarksSummary,
  handlePostBookmark,
  handleDeleteBookmark,
} from "./bookmarksEndpoint";
import { handlePostR2Credentials } from "./r2CredentialsEndpoint";
import {
  handleGetShares,
  handlePostShares,
  handleDeleteShares,
} from "./sharesEndpoint";
import { handlePostSharedUrl } from "./sharedUrlEndpoint";
import { requireVar } from "./requireVar";

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
  // One document's own row -- refreshing a single document's
  // access_blob/access_version after a 412 (docs/data_model.md §4)
  // without re-reading the whole library, see documentsEndpoint.ts.
  "/v1/documents/:id": {
    GET: { handler: (_request, env, ctx) => handleGetDocument(env, ctx.params.id) },
  },
  "/v1/catalog": {
    GET: { handler: (_request, env) => handleGetCatalog(env) },
  },
  "/v1/documents/:id/access": {
    PATCH: {
      requiresProof: true,
      handler: (_request, env, ctx) =>
        handlePatchDocumentAccess(env, ctx.params.id, ctx.proof!),
    },
  },
  // One document's content key + pointer, fetched lazily only when a
  // reader session actually opens that book -- see documentsEndpoint.ts.
  "/v1/documents/:id/content": {
    GET: {
      handler: (_request, env, ctx) => handleGetDocumentContent(env, ctx.params.id),
    },
  },
  "/v1/bookmarks": {
    GET: { handler: (request, env) => handleGetBookmarks(env, new URL(request.url)) },
    POST: {
      requiresProof: true,
      handler: (_request, env, ctx) => handlePostBookmark(env, ctx.proof!),
    },
  },
  // Registered before "/v1/bookmarks/:id" below -- findRoute() matches in
  // insertion order, and both patterns have the same segment count, so
  // "summary" would otherwise be captured as an :id.
  "/v1/bookmarks/summary": {
    GET: { handler: (_request, env) => handleGetBookmarksSummary(env) },
  },
  "/v1/bookmarks/:id": {
    DELETE: {
      requiresProof: true,
      handler: (_request, env, ctx) => handleDeleteBookmark(env, ctx.params.id),
    },
  },
  "/v1/r2-credentials": {
    POST: {
      requiresProof: true,
      handler: (_request, env, ctx) => handlePostR2Credentials(env, ctx.proof!),
    },
  },
  "/v1/shares": {
    GET: { handler: (_request, env) => handleGetShares(env) },
    POST: {
      requiresProof: true,
      handler: (_request, env, ctx) => handlePostShares(env, ctx.proof!),
    },
    DELETE: {
      requiresProof: true,
      handler: (_request, env, ctx) => handleDeleteShares(env, ctx.proof!),
    },
  },
  // The one /v1/* route excluded from Access (docs/auth.md §1,
  // docs/sharing.md) -- capability possession is the entire
  // authorization.
  "/v1/shared-url": {
    POST: {
      public: true,
      handler: (request, env) => handlePostSharedUrl(request, env),
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

// TESTING ONLY, never set for a real deployment (docs/deployment.md §2):
// lets every non-public /v1/* route through with no Access session at
// all, for exercising the rest of the app before an Access application
// exists. Synthesizes the claims a verified session would have carried
// so downstream code (e.g. GET /v1/owner's ticket issuance) still sees a
// consistent `access.email`. Cast away the literal-string type
// `wrangler types` infers from the committed "false" default, the same
// reason requireVar() exists for the other vars.
function accessCheckSkipped(env: Env): boolean {
  return (env.SKIP_ACCESS_CHECK as string | undefined) === "true";
}

async function resolveAccess(
  request: Request,
  env: Env,
): Promise<AccessJwtClaims | null> {
  if (accessCheckSkipped(env)) {
    return {
      email: requireVar(env.OWNER_EMAIL, "OWNER_EMAIL"),
      aud: [],
      exp: Infinity,
      iss: "",
    };
  }
  try {
    return await requireAccess(request, env);
  } catch (error) {
    // The client-facing response stays a uniform 401 (docs/auth.md §2) --
    // this is server-side only, visible via `wrangler tail`, and is the
    // one place that says *why* a session Access itself already accepted
    // still failed the Worker's own independent check (wrong
    // CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD/OWNER_EMAIL, or an Access
    // application gating a different host/path than this deployment).
    console.error(
      `Access verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
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
    const resolved = await resolveAccess(request, env);
    if (!resolved) {
      // Deliberately uniform: which check failed isn't revealed to the
      // caller (docs/auth.md's Access session is either present and valid,
      // or the request doesn't get further than this).
      return new Response("Unauthorized", { status: 401 });
    }
    access = resolved;
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
