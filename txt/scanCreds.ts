// Loading/validating the creds.json shape --clean-bucket/--update-db-catalog/
// --update-db-prefixHash all take -- much smaller than InitAdminCreds: no
// Firebase fields at all, since none of these commands sign in as any
// particular account (each enumerates every account directly via the Admin
// SDK, which bypasses instant.perms.ts entirely). The only external secret
// needed is the admin's own user_root_key, the entry point into its own umk.
// From there each command finds the admin-owned credStore row that carries
// the real read-write R2 config.
import { readFileSync } from "node:fs";
import * as C from "./constants.ts";
import { checkKeyLength, requireField } from "./creds.ts";

export interface ScanCreds {
  instantAppId: string;
  instantAdminToken: string;
  userRootKey: Buffer;
}

export function loadScanCreds(path: string): ScanCreds {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const userRootKey = Buffer.from(
    requireField(raw.user_root_key, "user_root_key"),
    "base64",
  );
  checkKeyLength(userRootKey, C.USER_ROOT_KEY_MIN_LEN, "user_root_key");
  return {
    instantAppId: requireField(raw.instant_app_id, "instant_app_id"),
    instantAdminToken: requireField(
      raw.instant_admin_token,
      "instant_admin_token",
    ),
    userRootKey,
  };
}
