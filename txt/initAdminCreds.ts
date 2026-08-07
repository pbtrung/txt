// Loading/validating the creds.json shape --init-admin takes -- distinct
// from txt/creds.ts's Creds (that one's for --migrate --from-creds, against
// a local sqlite snapshot; this one provisions the admin account directly
// against a live Firebase project + InstantDB app).
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as C from "./constants.ts";
import {
  checkKeyLength,
  loadR2Config,
  requireField,
  type R2ConfigResolved,
} from "./creds.ts";
import type { Logger } from "./logger.ts";

export interface InitAdminCreds {
  instantAppId: string;
  instantClientName: string;
  instantAdminToken: string;
  firebaseEmail: string;
  firebasePassword: string;
  firebaseApiKey: string;
  displayName: string;
  // null when loaded with requireR2: false (--migrate --to-creds) -- that
  // path reads R2 config from the target account's own live credStore row
  // instead (docs/data_model.md's credStore entity), since it's the
  // account's actual, current connection info and to-creds.json's own copy
  // could drift from it. --init-admin still needs a real local one (there's
  // no credStore row yet to read it from before that command creates it).
  r2Config: R2ConfigResolved | null;
  userRootKey: Buffer;
  // Neither field is read by --init-admin/--migrate/--collect-garbage --
  // both are carried through unvalidated, purely so a single creds.json can
  // also serve as ui/'s own build-creds.json (npm run deploy) without a
  // second file: slhdsa256fPrivKey is that command's SLH-DSA-256f signing
  // key (generated once, then reused -- see
  // ui/scripts/build-integrity.mjs), assetBaseUrl the public URL its build
  // is served from. Empty string when absent from creds.json.
  slhdsa256fPrivKey: string;
  assetBaseUrl: string;
}

// --init-admin only: if creds.json's user_root_key is empty/missing,
// generates USER_ROOT_KEY_MIN_LEN (256) random bytes and writes them back
// into the same file, base64-encoded -- mirrors
// ui/scripts/build-integrity.mjs's own generate-once-then-reuse pattern for
// build-creds.json's slhdsa_256f_priv_key. user_root_key is the one external
// secret this whole design's key hierarchy is wrapped under (docs/
// data_model.md) -- losing it means losing the ability to ever unlock this
// account's data again, so this only ever fills in a *missing* value, never
// overwrites one that's already present (even a too-short one -- that's
// still a real, deliberate value from somewhere, and loadInitAdminCreds's
// own checkKeyLength will reject it with a clear error instead).
export function ensureUserRootKeyGenerated(path: string, log: Logger): void {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw.user_root_key === "string" && raw.user_root_key.length > 0) {
    return;
  }
  raw.user_root_key = randomBytes(C.USER_ROOT_KEY_MIN_LEN).toString("base64");
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  log.info(
    `${path}: user_root_key was empty -- generated a new one and saved it back into this file. ` +
      `Back this file up now: it's the only way to ever unlock this account's data again.`,
  );
}

function requireReadWriteR2(r2: R2ConfigResolved): void {
  if (!(r2.readWriteAccessKeyId && r2.readWriteSecretAccessKey)) {
    throw new Error(
      "r2_config must include read_write_access_key_id/read_write_secret_access_key -- " +
        "--init-admin provisions the admin's own database, which always needs write access",
    );
  }
}

export function loadInitAdminCreds(
  path: string,
  opts: { requireR2?: boolean } = {},
): InitAdminCreds {
  const requireR2 = opts.requireR2 ?? true;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  let r2Config: R2ConfigResolved | null = null;
  if (requireR2) {
    r2Config = loadR2Config(raw);
    requireReadWriteR2(r2Config);
  }
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
    slhdsa256fPrivKey:
      typeof raw.slhdsa_256f_priv_key === "string"
        ? raw.slhdsa_256f_priv_key
        : "",
    assetBaseUrl:
      typeof raw.asset_base_url === "string" ? raw.asset_base_url : "",
  };
}
