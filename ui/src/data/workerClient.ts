// Same-origin client for wrapped key material and signed, short-lived R2
// credentials. Proofs are built only after choosing the exact Firebase token
// that will be sent in the Authorization header.
import { P521_SIGNATURE_BYTES, canonicalR2Proof } from "../../../shared/r2Proof";
import type { FirebaseTokenProvider } from "../auth/firebaseSignIn";
import { toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";

const PROOF_VERSION = 1;
const PROOF_LIFETIME_SECONDS = 45;

export interface KeysResponse {
  uid: string;
  umk: string; // base64
  signing: {
    version: number;
    algorithm: "ECDSA-P521-SHA512";
    privateKey: string; // base64 ciphertext
  };
  credStore: string; // base64
}

export interface R2SigningIdentity {
  uid: string;
  version: number;
  privateKey: CryptoKey;
}

export interface R2TempCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
  endpoint: string;
  bucket: string;
  region: string;
}

export interface R2CredentialPair {
  dbPath: R2TempCredential;
  dbPrefix: R2TempCredential;
}

export class WorkerClient {
  constructor(private readonly tokens: FirebaseTokenProvider) {}

  async fetchKeys(): Promise<KeysResponse> {
    let response = await this.authorizedPost("/v1/keys", false);
    if (response.status === 401) {
      response = await this.authorizedPost("/v1/keys", true);
    }
    if (response.status === 403) {
      throw new Error(
        "account not provisioned yet -- ask the administrator to set it up",
      );
    }
    if (!response.ok) {
      throw new Error(`could not obtain key material: ${response.status}`);
    }
    return parseKeysResponse(await response.json());
  }

  async fetchR2Token(
    dbPath: string,
    dbPrefix: string,
    signing: R2SigningIdentity,
    signal?: AbortSignal,
  ): Promise<R2CredentialPair> {
    let response = await this.signedR2Request(dbPath, dbPrefix, signing, false, signal);
    if (response.status === 401) {
      response = await this.signedR2Request(dbPath, dbPrefix, signing, true, signal);
    }
    if (!response.ok) {
      throw new Error(`could not obtain R2 credentials: ${response.status}`);
    }
    return parseR2CredentialPair(await response.json());
  }

  private async signedR2Request(
    dbPath: string,
    dbPrefix: string,
    signing: R2SigningIdentity,
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const idToken = await this.tokens.getIdToken(forceRefresh);
    const expiresAt = Math.floor(Date.now() / 1000) + PROOF_LIFETIME_SECONDS;
    const requestId = crypto.getRandomValues(new Uint8Array(32));
    const canonical = await canonicalR2Proof({
      version: signing.version,
      uid: signing.uid,
      firebaseIdToken: idToken,
      expiresAt,
      requestId,
      dbPath,
      dbPrefix,
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-512" },
        signing.privateKey,
        new Uint8Array(canonical),
      ),
    );
    if (signature.byteLength !== P521_SIGNATURE_BYTES) {
      throw new Error(
        `Web Crypto returned an invalid P-521 signature size: ${signature.byteLength}`,
      );
    }
    return this.post(
      "/v1/r2-token",
      idToken,
      {
        db_path: dbPath,
        db_prefix: dbPrefix,
        proof: {
          version: signing.version,
          expires_at: expiresAt,
          request_id: toBase64(requestId),
          signature: toBase64(signature),
        },
      },
      signal,
    );
  }

  private async authorizedPost(path: string, forceRefresh: boolean): Promise<Response> {
    return this.post(path, await this.tokens.getIdToken(forceRefresh));
  }

  private post(
    path: string,
    idToken: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  }
}

function parseKeysResponse(value: unknown): KeysResponse {
  const data = objectRecord(value, "key response");
  if (data.type !== "admin" && data.type !== "user") {
    throw new Error("key response has an invalid account type");
  }
  const signing = objectRecord(data.signing, "key response signing suite");
  if (signing.version !== PROOF_VERSION) {
    throw new Error("key response has an unsupported signing version");
  }
  if (signing.algorithm !== "ECDSA-P521-SHA512") {
    throw new Error("key response has an unsupported signing algorithm");
  }
  return {
    uid: stringField(data, "uid", "key response"),
    umk: stringField(data, "umk", "key response"),
    signing: {
      version: PROOF_VERSION,
      algorithm: "ECDSA-P521-SHA512",
      privateKey: stringField(signing, "private_key", "key response signing suite"),
    },
    credStore: stringField(data, "cred_store", "key response"),
  };
}

function parseR2CredentialPair(value: unknown): R2CredentialPair {
  const data = objectRecord(value, "R2 credential response");
  if (!Array.isArray(data.credentials)) {
    throw new Error("R2 credential response is missing credentials");
  }
  const common = {
    endpoint: stringField(data, "endpoint", "R2 credential response"),
    bucket: stringField(data, "bucket", "R2 credential response"),
    region: stringField(data, "region", "R2 credential response"),
  };
  let dbPath: R2TempCredential | null = null;
  let dbPrefix: R2TempCredential | null = null;
  for (const value of data.credentials) {
    const item = objectRecord(value, "R2 credential");
    const type = stringField(item, "type", "R2 credential");
    const credential = parseR2Credential(item, common);
    if (type === "db_path" && dbPath === null) dbPath = credential;
    else if (type === "db_prefix" && dbPrefix === null) dbPrefix = credential;
    else
      throw new Error(`R2 credential response has duplicate or unknown type: ${type}`);
  }
  if (!dbPath || !dbPrefix) {
    throw new Error("R2 credential response must contain db_path and db_prefix");
  }
  return { dbPath, dbPrefix };
}

function parseR2Credential(
  data: Record<string, unknown>,
  common: Pick<R2TempCredential, "endpoint" | "bucket" | "region">,
): R2TempCredential {
  return {
    accessKeyId: stringField(data, "access_key_id", "R2 credential"),
    secretAccessKey: stringField(data, "secret_access_key", "R2 credential"),
    sessionToken: stringField(data, "session_token", "R2 credential"),
    expiration: stringField(data, "expiration", "R2 credential"),
    ...common,
  };
}
