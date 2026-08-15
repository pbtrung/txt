// A plain REST call to Firebase's Identity Toolkit, mirroring
// txt/firebase_auth.py's FirebaseAuth.sign_in -- not the Firebase client
// SDK, which would need a full firebaseConfig (authDomain, projectId, ...)
// this client's reduced creds.json doesn't carry. The browser additionally
// needs the idToken itself (to call the Worker's /v1/keys), which the
// Python side never does since it only ever needs the uid.
const SIGN_IN_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

export interface FirebaseSession {
  idToken: string;
  uid: string;
}

export async function signIn(
  apiKey: string,
  email: string,
  password: string,
): Promise<FirebaseSession> {
  const resp = await fetch(`${SIGN_IN_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!resp.ok) throw new Error(`Firebase sign-in failed: ${resp.status}`);
  const data = (await resp.json()) as { idToken: string; localId: string };
  return { idToken: data.idToken, uid: data.localId };
}
