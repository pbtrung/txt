// Firebase client-side sign-in for the admin account's own session --
// mirrors docs/data_model.md's Auth section ("Every unlock requires a live
// Firebase sign-in ... getIdToken() -> db.auth.signInWithIdToken()"). Uses
// the real firebase/auth client SDK, unlike the CLI's txt/firebaseAuth.ts
// (which hand-rolls the Identity Toolkit REST call directly, since Node has
// no client SDK story worth using for a one-shot script) -- this runs in a
// real browser, where the SDK's own session/token-refresh handling is the
// right tool, not something to reimplement.

import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, type Auth } from "firebase/auth";

// Every field on Firebase's own FirebaseOptions type is optional (confirmed
// in @firebase/app's own type declarations) -- authDomain/projectId are
// only load-bearing for things this app doesn't do (OAuth redirect sign-in,
// other Firebase products), so plain email/password sign-in genuinely only
// needs apiKey. Kept optional here rather than required, matching that.
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId?: string;
}

export interface FirebaseSession {
  auth: Auth;
  idToken: string;
}

let cachedApp: FirebaseApp | null = null;

// initializeApp() throws ("Firebase App named '[DEFAULT]' already exists")
// if called twice -- VaultContext's unlock() can run more than once per page
// load (lock, then re-unlock), so getting the app has to be idempotent
// across calls rather than assuming a fresh module instance every time.
function getApp(config: FirebaseWebConfig): FirebaseApp {
  if (!cachedApp) cachedApp = initializeApp(config);
  return cachedApp;
}

/** Signs in with email/password and returns a fresh ID token --
 * @instantdb/react's db.auth.signInWithIdToken() needs the token itself,
 * not the Auth instance; callers that need to force-refresh later
 * (getIdToken(true)) hold onto FirebaseSession.auth.currentUser instead. */
export async function signIn(
  config: FirebaseWebConfig,
  email: string,
  password: string,
): Promise<FirebaseSession> {
  const auth = getAuth(getApp(config));
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const idToken = await credential.user.getIdToken();
  return { auth, idToken };
}
