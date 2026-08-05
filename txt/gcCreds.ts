// Loading/validating the creds.json shape --collect-garbage takes -- much
// smaller than InitAdminCreds: no Firebase fields at all, since garbage
// collection never signs in as any particular account (collectGarbage.ts
// enumerates every account directly via the Admin SDK, which bypasses
// instant.perms.ts entirely). The only external secret it needs is the
// admin's own user_root_key, the entry point into its own umk. From there
// collectGarbage.ts finds the admin-owned credStore row that carries the
// real read-write R2 config.
import { readFileSync } from "node:fs";
import * as C from "./constants.ts";
import { checkKeyLength, requireField } from "./creds.ts";

export interface GcCreds {
  instantAppId: string;
  instantAdminToken: string;
  userRootKey: Buffer;
}

export function loadGcCreds(path: string): GcCreds {
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
