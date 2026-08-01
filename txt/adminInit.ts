// Orchestrates --init-admin: provisions the admin account end to end,
// per docs/data_model.md's Key Hierarchy and "Non-admin (user-role)
// accounts" > Provisioning (the admin does for itself here exactly what it
// later does for a user account).
import { randomBytes } from "node:crypto";
import { id, init, tx } from "@instantdb/admin";
import * as C from "./constants.ts";
import { CryptoEngine } from "./crypto.ts";
import type { InitAdminCreds } from "./initAdminCreds.ts";
import { signInWithPassword } from "./firebaseAuth.ts";
import { signInWithFirebaseIdToken } from "./instantSignIn.ts";
import type { Logger } from "./logger.ts";
import { computeR2Prefix } from "./pagePointer.ts";
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
  usersRowId: string;
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
    const usersRowId = id();
    await this.createAdminProfile(db, authId, usersRowId, cryptoEngine, keys);
    const commit = await this.commitInitialPages(
      db,
      cryptoEngine,
      keys,
      authId,
      usersRowId,
      dirtyPages,
      pageCount,
    );
    return {
      authId,
      usersRowId,
      dbMetaId: commit.dbMetaId,
      pageCount,
      version: commit.newVersion,
    };
  }

  private async signIn(): Promise<string> {
    const idToken = await signInWithPassword(
      this.creds.firebaseApiKey,
      this.creds.firebaseEmail,
      this.creds.firebasePassword,
    );
    const result = await signInWithFirebaseIdToken(
      this.creds.instantAppId,
      this.creds.instantClientName,
      idToken,
    );
    this.log.info(
      `Signed in: auth.id=${result.authId} (email=${result.email}, created=${result.created})`,
    );
    return result.authId;
  }

  private async failIfAlreadyInitialized(
    db: any,
    authId: string,
  ): Promise<void> {
    const result = await db.query({
      users: { $: { where: { "authUser.id": authId } } },
    });
    if (result.users?.length > 0) {
      throw new Error(
        `account for auth.id=${authId} is already initialized (users row ${result.users[0].id} exists)`,
      );
    }
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
    return {
      dirtyPages: vfs.diffDirtyPages(),
      pageCount: vfs.currentPageCount,
    };
  }

  private async createAdminProfile(
    db: any,
    authId: string,
    usersRowId: string,
    cryptoEngine: CryptoEngine,
    keys: GeneratedKeys,
  ): Promise<void> {
    const umkBlob = cryptoEngine
      .blobEncrypt(this.creds.userRootKey, keys.umk)
      .toString("base64");
    const credsBlob = this.wrapCreds(cryptoEngine, keys);
    await db.transact([
      tx.users[usersRowId].update({ type: "admin" }).link({ authUser: authId }),
      tx.$users[authId].update({ umk: umkBlob, creds: credsBlob }),
    ]);
    this.log.info(
      `Created users row ${usersRowId} (type=admin) and set $users.umk/creds`,
    );
  }

  // docs/data_model.md's $users.creds shape uses snake_case keys (mirroring
  // the original creds.json), not this codebase's camelCase R2ConfigResolved.
  private wrapCreds(cryptoEngine: CryptoEngine, keys: GeneratedKeys): string {
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
    usersRowId: string,
    dirtyPages: Map<number, Buffer>,
    pageCount: number,
  ): Promise<{ dbMetaId: string; newVersion: number }> {
    const r2 = new R2Client(this.creds.r2Config, false, this.log);
    const r2Prefix = computeR2Prefix(authId);
    const store = new RemotePageStore({
      db,
      r2,
      crypto: cryptoEngine,
      pathKey: keys.pathKey,
      authId,
      r2Prefix,
      ownerId: usersRowId,
    });
    const dbMetaId = id();
    const { newVersion } = await store.commitPages(
      dirtyPages,
      dbMetaId,
      0,
      pageCount,
    );
    this.log.info(
      `Committed ${dirtyPages.size} page(s) as version=${newVersion}, dbMeta=${dbMetaId}`,
    );
    return { dbMetaId, newVersion };
  }
}
