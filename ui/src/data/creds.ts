// The unlock file (see screens/Unlock/UnlockScreen.tsx) is the same
// creds.json shape the CLI's --init-admin/--migrate --to-creds already take
// (txt/initAdminCreds.ts) -- the admin's one credentials file now works for
// both, rather than needing a separate browser-specific bundle. This parser
// only requires firebase_email/firebase_password/firebase_api_key (the
// fields plain email/password sign-in actually needs), plus instant_app_id/
// instant_client_name/user_root_key -- firebase_auth_domain/
// firebase_project_id are accepted but optional: every field on Firebase's
// own FirebaseOptions type is optional, and authDomain/projectId are only
// load-bearing for things this app doesn't do (OAuth redirect flows, other
// Firebase products) -- see firebaseAuth.ts's FirebaseWebConfig. instant_admin_token
// and r2_config, present in the CLI's version of this same file, are simply
// ignored here: a browser session never holds an admin token, and this
// account's R2 config comes from its own (already-InstantDB-stored)
// credStore row instead (session.ts's resolveSession).

import { base64ToBytes } from "../crypto/bytes";
import { optionalString, requireObject, requireString } from "./jsonObject";

export interface Creds {
  firebaseEmail: string;
  firebasePassword: string;
  firebaseApiKey: string;
  firebaseAuthDomain?: string;
  firebaseProjectId?: string;
  instantAppId: string;
  instantClientName: string;
  userRootKey: Uint8Array;
  /** Purely cosmetic -- shown in AccountFooter next to the person icon, but
   * only if this account's own credStore.content.display_name (the
   * canonical source, see session.ts's Session.displayName) isn't set;
   * falls back further to the signed-in Firebase account's own email if
   * this is absent too (see VaultContext.tsx's unlock()). */
  displayName?: string;
}

export class CredsError extends Error {}

/** Parses the unlock file's JSON contents into validated Creds. */
export function parseCreds(json: unknown): Creds {
  const data = requireObject(
    json,
    "creds file must be a JSON object",
    CredsError,
  );

  const firebaseEmail = requireString(data, "firebase_email", CredsError);
  const firebasePassword = requireString(data, "firebase_password", CredsError);
  const firebaseApiKey = requireString(data, "firebase_api_key", CredsError);
  const instantAppId = requireString(data, "instant_app_id", CredsError);
  const instantClientName = requireString(
    data,
    "instant_client_name",
    CredsError,
  );

  let userRootKey: Uint8Array;
  try {
    userRootKey = base64ToBytes(
      requireString(data, "user_root_key", CredsError),
    );
  } catch {
    throw new CredsError("user_root_key must be valid base64");
  }
  if (userRootKey.length < 256) {
    throw new CredsError("user_root_key too short");
  }

  return {
    firebaseEmail,
    firebasePassword,
    firebaseApiKey,
    firebaseAuthDomain: optionalString(data, "firebase_auth_domain"),
    firebaseProjectId: optionalString(data, "firebase_project_id"),
    instantAppId,
    instantClientName,
    userRootKey,
    displayName: optionalString(data, "display_name"),
  };
}

export async function loadCredsFromFile(file: File): Promise<Creds> {
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CredsError("creds file is not valid JSON");
  }
  return parseCreds(json);
}
