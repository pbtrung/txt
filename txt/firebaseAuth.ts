// Firebase's Identity Toolkit REST API (accounts:signInWithPassword) -- the
// only step in --init-admin that needs a real network call to Firebase
// itself, since InstantDB's own signInWithIdToken (see instantSignIn.ts)
// needs an actual Firebase-issued idToken to verify.
const IDENTITY_TOOLKIT_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

interface SignInWithPasswordResponse {
  idToken: string;
  localId: string;
}

interface SignInWithPasswordError {
  error: { message: string };
}

export async function signInWithPassword(
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
  if (!resp.ok) throw firebaseError(body as SignInWithPasswordError, email);
  return (body as SignInWithPasswordResponse).idToken;
}

function firebaseError(body: SignInWithPasswordError, email: string): Error {
  const code = body.error?.message ?? "unknown error";
  return new Error(
    `Firebase sign-in failed for ${JSON.stringify(email)}: ${code} -- ` +
      "the account must already exist (this tool never creates one)",
  );
}
