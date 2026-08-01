// Exchanges a Firebase ID token for an InstantDB session -- resolves/creates
// the $users row for a Firebase-verified identity (per data_model.md's Auth
// section), the one operation the admin SDK has no equivalent for.
//
// This calls InstantDB's own runtime endpoint directly with plain fetch,
// rather than using @instantdb/core's init()/signInWithIdToken: that SDK's
// Reactor is fundamentally browser-only (confirmed empirically) -- its
// constructor checks `typeof window !== 'undefined' || typeof chrome !==
// 'undefined'` and returns immediately if neither is true, silently skipping
// all storage/state setup (this.kv, etc. are simply never assigned), which
// crashes signInWithIdToken deep inside the SDK ("Cannot read properties of
// undefined (reading 'updateInPlace')") when run under plain Node. The
// underlying wire call it would have made is small and stable -- POST
// {apiURI}/runtime/oauth/id_token, matching @instantdb/core's own internal
// (but not publicly exported -- `exports` in its package.json blocks
// `@instantdb/core/dist/esm/authAPI.js`) authAPI.js signInWithIdToken -- so
// this replicates just that call instead of pulling in a DOM/indexedDB
// polyfill (fake-indexeddb, jsdom, ...) to satisfy the Reactor's browser
// assumptions for one narrow operation.
const INSTANT_API_URI = "https://api.instantdb.com";

export interface InstantSignInResult {
  authId: string; // $users id
  email: string | null | undefined;
  created: boolean;
}

interface IdTokenSignInResponse {
  user: { id: string; email?: string | null };
  created: boolean;
}

export async function signInWithFirebaseIdToken(
  appId: string,
  clientName: string,
  idToken: string,
): Promise<InstantSignInResult> {
  const resp = await fetch(`${INSTANT_API_URI}/runtime/oauth/id_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      app_id: appId,
      id_token: idToken,
      client_name: clientName,
    }),
  });
  const body = await resp.json();
  if (!resp.ok) throw instantError(body, appId, clientName);
  const { user, created } = body as IdTokenSignInResponse;
  return { authId: user.id, email: user.email, created };
}

function instantError(body: any, appId: string, clientName: string): Error {
  const message = body?.message ?? body?.body?.message ?? "unknown error";
  return new Error(
    `InstantDB signInWithIdToken failed (appId=${appId}, clientName=${JSON.stringify(clientName)}): ${message}`,
  );
}
