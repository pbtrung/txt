// Loading/validating the creds.json shape --init-admin takes -- distinct
// from txt/creds.ts's Creds (that one's for --clean-bucket, against a local
// sqlite snapshot; this one provisions the admin account directly against a
// live Firebase project + InstantDB app).
import { readFileSync } from "node:fs";
import * as C from "./constants.ts";
import {
  checkKeyLength,
  loadR2Config,
  requireField,
  type R2ConfigResolved,
} from "./creds.ts";

export interface InitAdminCreds {
  instantAppId: string;
  instantClientName: string;
  instantAdminToken: string;
  firebaseEmail: string;
  firebasePassword: string;
  firebaseApiKey: string;
  displayName: string;
  r2Config: R2ConfigResolved;
  userRootKey: Buffer;
}

function requireReadWriteR2(r2: R2ConfigResolved): void {
  if (!(r2.readWriteAccessKeyId && r2.readWriteSecretAccessKey)) {
    throw new Error(
      "r2_config must include read_write_access_key_id/read_write_secret_access_key -- " +
        "--init-admin provisions the admin's own database, which always needs write access",
    );
  }
}

export function loadInitAdminCreds(path: string): InitAdminCreds {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const r2Config = loadR2Config(raw);
  requireReadWriteR2(r2Config);
  const userRootKey = Buffer.from(
    requireField(raw.user_root_key, "user_root_key"),
    "base64",
  );
  checkKeyLength(userRootKey, C.USER_ROOT_KEY_MIN_LEN, "user_root_key");
  return {
    instantAppId: requireField(raw.instant_app_id, "instant_app_id"),
    instantClientName: requireField(
      raw.instant_client_name,
      "instant_client_name",
    ),
    instantAdminToken: requireField(
      raw.instant_admin_token,
      "instant_admin_token",
    ),
    firebaseEmail: requireField(raw.firebase_email, "firebase_email"),
    firebasePassword: requireField(raw.firebase_password, "firebase_password"),
    firebaseApiKey: requireField(raw.firebase_api_key, "firebase_api_key"),
    displayName: requireField(raw.display_name, "display_name"),
    r2Config,
    userRootKey,
  };
}
