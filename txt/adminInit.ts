// Orchestrates --init-admin: provisions the admin account end to end, per
// docs/key_hierarchy.md and docs/r2_credentials.md's "Provisioning a `user`
// account" (the admin does for itself here exactly what it later does for a
// user account, minus the "another account grants it a share" step -- the
// admin is the one account that never needs one).
import { randomBytes } from "node:crypto";
import { id, init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { CryptoEngine } from "./crypto.ts";
import type { InitAdminCreds } from "./initAdminCreds.ts";
import { signInToInstant } from "./instantSignIn.ts";
import type { Logger } from "./logger.ts";

interface GeneratedKeys {
  umk: Buffer;
  keyStoreKey: Buffer;
  credStoreKey: Buffer;
}

export interface AdminInitResult {
  authId: string;
  keyStoreId: string;
  credStoreId: string;
}

function generateKeys(): GeneratedKeys {
  return {
    umk: randomBytes(C.RANDOM_KEY_LEN),
    keyStoreKey: randomBytes(C.RANDOM_KEY_LEN),
    credStoreKey: randomBytes(C.RANDOM_KEY_LEN),
  };
}

export class AdminInitializer {
  private creds: InitAdminCreds;
  private log: Logger;

  constructor(creds: InitAdminCreds, log: Logger) {
    this.creds = creds;
    this.log = log;
  }

  async run(): Promise<AdminInitResult> {
    const authId = await signInToInstant(this.creds, this.log);
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    await this.failIfAlreadyInitialized(db, authId);
    const cryptoEngine = await CryptoEngine.create();
    const keys = generateKeys();
    return this.writeAdminIdentity(db, authId, cryptoEngine, keys);
  }

  private async failIfAlreadyInitialized(
    db: any,
    authId: string,
  ): Promise<void> {
    const result = await db.query({
      keyStore: { $: { where: { "owner.id": authId } } },
    });
    if (result.keyStore?.length > 0) {
      throw new Error(
        `account for auth.id=${authId} is already initialized (keyStore row ${result.keyStore[0].id} exists)`,
      );
    }
    this.log.debug(`No existing keyStore row for auth.id=${authId}`);
  }

  // Sets type/umk directly on $users (no separate profile row -- see
  // instant.schema.ts), generates this account's own lc_kyber_1024_x448
  // composite keypair and writes it as a keyStore row, and writes this
  // account's own credStore row (docs/data_model.md's keyStore/credStore
  // entities) -- all in one transact().
  private async writeAdminIdentity(
    db: any,
    authId: string,
    cryptoEngine: CryptoEngine,
    keys: GeneratedKeys,
  ): Promise<AdminInitResult> {
    const umkBlob = cryptoEngine
      .blobEncrypt(this.creds.userRootKey, keys.umk, false)
      .toString("base64");
    const { pubKey, privKey } = cryptoEngine.kemKeypair();
    const keyStoreKeyBlob = cryptoEngine
      .blobEncrypt(keys.umk, keys.keyStoreKey, false)
      .toString("base64");
    const privKeyBlob = cryptoEngine
      .blobEncrypt(keys.keyStoreKey, privKey, false)
      .toString("base64");
    const credStoreKeyBlob = cryptoEngine
      .blobEncrypt(keys.umk, keys.credStoreKey, false)
      .toString("base64");
    const contentBlob = this.wrapCredStoreContent(cryptoEngine, keys);

    const keyStoreId = id();
    const credStoreId = id();
    await db.transact([
      tx.$users![authId]!.update({ type: "admin", umk: umkBlob }),
      tx
        .keyStore![keyStoreId]!.update({
          pubKey: pubKey.toString("base64"),
          keyStoreKey: keyStoreKeyBlob,
          privKey: privKeyBlob,
        })
        .link({ owner: authId }),
      tx
        .credStore![credStoreId]!.update({
          credStoreKey: credStoreKeyBlob,
          content: contentBlob,
        })
        .link({ owner: authId, forUser: authId }),
    ]);
    this.log.info(
      `Set $users.type=admin/umk, wrote keyStore row ${keyStoreId} and credStore row ${credStoreId}`,
    );
    return { authId, keyStoreId, credStoreId };
  }

  // docs/data_model.md's credStore content shape uses snake_case keys
  // (mirroring the original creds.json), not this codebase's camelCase
  // R2ConfigResolved.
  private wrapCredStoreContent(
    cryptoEngine: CryptoEngine,
    keys: GeneratedKeys,
  ): string {
    const r2 = this.creds.r2Config;
    const payload = {
      r2_config: {
        endpoint: r2.endpoint,
        read_only_access_key_id: r2.readOnlyAccessKeyId,
        read_only_secret_access_key: r2.readOnlySecretAccessKey,
        read_write_access_key_id: r2.readWriteAccessKeyId,
        read_write_secret_access_key: r2.readWriteSecretAccessKey,
        region: r2.region,
        bucket: r2.bucket,
      },
      display_name: this.creds.displayName,
    };
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    return cryptoEngine
      .blobEncrypt(keys.credStoreKey, plaintext, true)
      .toString("base64");
  }
}
