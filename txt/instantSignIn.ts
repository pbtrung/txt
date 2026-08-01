// The one step that needs @instantdb/core (not the admin SDK): InstantDB
// creates/resolves the $users row for a Firebase-verified identity only as
// a side effect of a real signInWithIdToken call -- there's no admin-SDK
// equivalent for this. Everything else in --init-admin uses @instantdb/admin.
import { init } from "@instantdb/core";

export interface InstantSignInResult {
  authId: string; // $users id
  email: string | null | undefined;
  created: boolean;
}

export async function signInWithFirebaseIdToken(
  appId: string,
  clientName: string,
  idToken: string,
): Promise<InstantSignInResult> {
  const db = init({ appId });
  try {
    const { user, created } = await db.auth.signInWithIdToken({
      idToken,
      clientName,
    });
    return { authId: user.id, email: user.email, created };
  } finally {
    db.shutdown();
  }
}
