const IDENTITY_TOOLKIT_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const INSTANT_API_URI = "https://api.instantdb.com";

interface SignInWithPasswordResponse {
  idToken: string;
}

interface SignInWithPasswordError {
  error?: { message?: string };
}

interface IdTokenSignInResponse {
  user: { id: string; email?: string | null };
  created: boolean;
}

export interface InstantSignInResult {
  authId: string;
  email?: string | null;
  created: boolean;
}

export async function signInWithPasswordForIdToken(
  apiKey: string,
  email: string,
  password: string,
): Promise<string> {
  const resp = await fetch(`${IDENTITY_TOOLKIT_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await resp.json();
  if (!resp.ok) {
    const message =
      (body as SignInWithPasswordError).error?.message ?? "unknown error";
    throw new Error(
      `Firebase sign-in failed for ${JSON.stringify(email)}: ${message}`,
    );
  }
  return (body as SignInWithPasswordResponse).idToken;
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
  if (!resp.ok) {
    const message = body?.message ?? body?.body?.message ?? "unknown error";
    throw new Error(
      `InstantDB signInWithIdToken failed (appId=${appId}, clientName=${JSON.stringify(clientName)}): ${message}`,
    );
  }
  const { user, created } = body as IdTokenSignInResponse;
  return { authId: user.id, email: user.email, created };
}

export async function resolveInstantAuthId(input: {
  instantAppId: string;
  instantClientName: string;
  firebaseEmail: string;
  firebasePassword: string;
  firebaseApiKey: string;
}): Promise<InstantSignInResult> {
  const idToken = await signInWithPasswordForIdToken(
    input.firebaseApiKey,
    input.firebaseEmail,
    input.firebasePassword,
  );
  return signInWithFirebaseIdToken(
    input.instantAppId,
    input.instantClientName,
    idToken,
  );
}
