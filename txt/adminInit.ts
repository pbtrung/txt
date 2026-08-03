// Orchestrates --init-admin: provisions the admin account end to end, per
// docs/data_model.md's Key Hierarchy and "Provisioning a `user` account"
// (the admin does for itself here exactly what it later does for a user
// account).
import { randomBytes } from "node:crypto";
import { id, init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { CryptoEngine } from "./crypto.ts";
import type { InitAdminCreds } from "./initAdminCreds.ts";
import { signInToInstant } from "./instantSignIn.ts";
import type { Logger } from "./logger.ts";
import { R2Client } from "./r2.ts";
import { R2Vfs } from "./r2Vfs.ts";
import { RemotePageStore } from "./remotePageStore.ts";
import { SCHEMA_SQL, SqlCipherBuilder } from "./sqlcipherBuilder.ts";

const DB_FILE_NAME = "/admin.db";
const UMK_LEN = 128;
const PATH_KEY_LEN = 128;
const DB_KEY_LEN = 256;

interface GeneratedKeys {
  umk: Buffer;
  pathKey: Buffer;
  dbKey: Buffer;
}

export interface AdminInitResult {
  authId: string;
  dbMetaId: string;
  pageCount: number;
  version: number;
}

function generateKeys(): GeneratedKeys {
  return {
    umk: randomBytes(UMK_LEN),
    pathKey: randomBytes(PATH_KEY_LEN),
    dbKey: randomBytes(DB_KEY_LEN),
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
    const authId = await this.signIn();
    const db = init({
      appId: this.creds.instantAppId,
      adminToken: this.creds.instantAdminToken,
    });
    await this.failIfAlreadyInitialized(db, authId);
    const keys = generateKeys();
    const cryptoEngine = await CryptoEngine.create();
    const { dirtyPages, pageCount } = await this.buildInitialDatabase(
      keys.dbKey,
    );
    await this.writeAdminIdentity(db, authId, cryptoEngine, keys);
    const commit = await this.commitInitialPages(
      db,
      cryptoEngine,
      keys,
      authId,
      dirtyPages,
      pageCount,
    );
    return {
      authId,
      dbMetaId: commit.dbMetaId,
      pageCount,
      version: commit.newVersion,
    };
  }

  // The real client-facing login path (Firebase password sign-in ->
  // POST /runtime/oauth/id_token, docs/data_model.md's Auth section) is what
  // actually creates (or resolves) this account's $users row -- confirmed
  // NOT interchangeable with pre-creating a row via the Admin SDK's
  // db.auth.createToken/verifyToken: a real end-to-end test showed the two
  // paths resolve to two different $users rows for the same email (the
  // oauth/id_token exchange came back with created=true and email=null,
  // meaning it never matched the Admin-SDK-created row at all). So this has
  // to be the one and only place this account's $users row gets created;
  // instant.perms.ts's $users.create rule stays unconditional ("true") to
  // allow it -- see that rule's own comment for why "isAdmin" doesn't work
  // here even once the row already exists.
  private async signIn(): Promise<string> {
    return signInToInstant(this.creds, this.log);
  }

  private async failIfAlreadyInitialized(
    db: any,
    authId: string,
  ): Promise<void> {
    const result = await db.query({
      dbMeta: { $: { where: { "owner.id": authId } } },
    });
    if (result.dbMeta?.length > 0) {
      throw new Error(
        `account for auth.id=${authId} is already initialized (dbMeta row ${result.dbMeta[0].id} exists)`,
      );
    }
    this.log.debug(`No existing dbMeta row for auth.id=${authId}`);
  }

  private async buildInitialDatabase(
    dbKey: Buffer,
  ): Promise<{ dirtyPages: Map<number, Buffer>; pageCount: number }> {
    const builder = await SqlCipherBuilder.create();
    const vfs = R2Vfs.registerNew(
      builder.module,
      DB_FILE_NAME,
      C.SQLCIPHER_PAGE_SIZE,
    );
    builder.run(DB_FILE_NAME, vfs.name, dbKey, SCHEMA_SQL);
    const dirtyPages = vfs.diffDirtyPages();
    this.log.debug(
      `Built initial SQLCipher database: ${dirtyPages.size} dirty page(s), pageCount=${vfs.currentPageCount}`,
    );
    return {
      dirtyPages,
      pageCount: vfs.currentPageCount,
    };
  }

  // Sets type/umk directly on $users (no separate profile row -- see
  // instant.schema.ts) and writes this account's own credStore row (owner =
  // user = this account, docs/data_model.md's credStore entity).
  private async writeAdminIdentity(
    db: any,
    authId: string,
    cryptoEngine: CryptoEngine,
    keys: GeneratedKeys,
  ): Promise<void> {
    const umkBlob = cryptoEngine
      .blobEncrypt(this.creds.userRootKey, keys.umk)
      .toString("base64");
    const contentBlob = this.wrapCredStoreContent(cryptoEngine, keys);
    const credStoreId = id();
    await db.transact([
      tx.$users[authId].update({ type: "admin", umk: umkBlob }),
      tx.credStore[credStoreId]
        .update({ content: contentBlob })
        .link({ owner: authId, user: authId }),
    ]);
    this.log.info(
      `Set $users.type=admin/umk and wrote credStore row ${credStoreId}`,
    );
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
      path_key: keys.pathKey.toString("base64"),
      db_key: keys.dbKey.toString("base64"),
    };
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    return cryptoEngine.blobEncrypt(keys.umk, plaintext).toString("base64");
  }

  private async commitInitialPages(
    db: any,
    cryptoEngine: CryptoEngine,
    keys: GeneratedKeys,
    authId: string,
    dirtyPages: Map<number, Buffer>,
    pageCount: number,
  ): Promise<{ dbMetaId: string; newVersion: number }> {
    const r2 = new R2Client(this.creds.r2Config, false, this.log);
    const store = new RemotePageStore({
      db,
      r2,
      crypto: cryptoEngine,
      pathKey: keys.pathKey,
      authId,
    });
    const dbMetaId = id();
    const { newVersion } = await store.commitPages(
      dirtyPages,
      dbMetaId,
      0,
      pageCount,
      C.SQLCIPHER_PAGE_SIZE,
    );
    this.log.info(
      `Committed ${dirtyPages.size} page(s) as version=${newVersion}, dbMeta=${dbMetaId}`,
    );
    return { dbMetaId, newVersion };
  }
}
