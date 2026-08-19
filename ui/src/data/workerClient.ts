// Same-origin client for wrapped key material and signed, short-lived R2
// credentials. Firebase is sent only to /v1/keys; R2 proofs bind the signed
// ticket returned there to the handle decrypted from cred_store.
import {
  P521_SIGNATURE_BYTES,
  R2_TICKET_PROOF_VERSION,
  canonicalR2TicketProof,
} from "../../../shared/r2Proof";
import type { FirebaseTokenProvider } from "../auth/firebaseSignIn";
import { toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";
import { withNetworkRetries } from "./networkRequest";

const SIGNING_VERSION = 1;
const PROOF_LIFETIME_SECONDS = 45;

export interface KeysResponse {
  type: "admin" | "user";
  uid: string;
  umk: string; // base64
  signing: {
    version: number;
    algorithm: "ECDSA-P521-SHA512";
    privateKey: string; // base64 ciphertext
  };
  credStore: string; // base64
  r2Ticket: string;
}

export interface R2SigningIdentity {
  ticket: string;
  userHandle: Uint8Array;
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

  async fetchKeys(signal?: AbortSignal): Promise<KeysResponse> {
    let response = await this.authorizedPost("/v1/keys", false, undefined, signal);
    if (response.status === 401) {
      response = await this.authorizedPost("/v1/keys", true, undefined, signal);
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
    let response = await this.signedR2Request(dbPath, dbPrefix, signing, signal);
    if (response.status === 401) {
      signing.ticket = (await this.fetchKeys(signal)).r2Ticket;
      response = await this.signedR2Request(dbPath, dbPrefix, signing, signal);
    }
    if (!response.ok) {
      throw new Error(`could not obtain R2 credentials: ${response.status}`);
    }
    return parseR2CredentialPair(await response.json());
  }

  async createShareGrant(request: ShareGrantRequest): Promise<string> {
    return withNetworkRetries(async (signal) => {
      const response = await this.authorizedPost(
        "/v1/share-grant",
        false,
        {
          db_path: request.dbPath,
          db_prefix: request.dbPrefix,
          share_prefix: request.sharePrefix,
          share_path: request.sharePath,
          share_id: request.shareId,
        },
        signal,
      );
      if (!response.ok) {
        throw new Error(`could not create share URL: ${response.status}`);
      }
      const data = objectRecord(await response.json(), "share grant response");
      return stringField(data, "grant", "share grant response");
    });
  }

  async deleteShare(request: ShareGrantRequest): Promise<void> {
    await withNetworkRetries(async (signal) => {
      const response = await this.authorizedRequest(
        "/v1/share",
        "DELETE",
        false,
        {
          db_path: request.dbPath,
          db_prefix: request.dbPrefix,
          share_prefix: request.sharePrefix,
          share_path: request.sharePath,
          share_id: request.shareId,
        },
        signal,
      );
      if (!response.ok) throw new Error(`could not delete share: ${response.status}`);
    });
  }

  private async signedR2Request(
    dbPath: string,
    dbPrefix: string,
    signing: R2SigningIdentity,
    signal?: AbortSignal,
  ): Promise<Response> {
    const expiresAt = Math.floor(Date.now() / 1000) + PROOF_LIFETIME_SECONDS;
    const requestId = crypto.getRandomValues(new Uint8Array(32));
    const canonical = await canonicalR2TicketProof({
      version: R2_TICKET_PROOF_VERSION,
      ticket: signing.ticket,
      userHandle: signing.userHandle,
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
    return fetch("/v1/r2-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: signing.ticket,
        user_handle: toBase64(signing.userHandle),
        db_path: dbPath,
        db_prefix: dbPrefix,
        proof: {
          version: R2_TICKET_PROOF_VERSION,
          expires_at: expiresAt,
          request_id: toBase64(requestId),
          signature: toBase64(signature),
        },
      }),
      signal,
    });
  }

  private async authorizedPost(
    path: string,
    forceRefresh: boolean,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.authorizedRequest(path, "POST", forceRefresh, body, signal);
  }

  private async authorizedRequest(
    path: string,
    method: string,
    forceRefresh: boolean,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const idToken = await this.tokens.getIdToken(forceRefresh, signal);
    return fetch(path, {
      method,
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
  if (signing.version !== SIGNING_VERSION) {
    throw new Error("key response has an unsupported signing version");
  }
  if (signing.algorithm !== "ECDSA-P521-SHA512") {
    throw new Error("key response has an unsupported signing algorithm");
  }
  return {
    type: data.type,
    uid: stringField(data, "uid", "key response"),
    umk: stringField(data, "umk", "key response"),
    signing: {
      version: SIGNING_VERSION,
      algorithm: "ECDSA-P521-SHA512",
      privateKey: stringField(signing, "private_key", "key response signing suite"),
    },
    credStore: stringField(data, "cred_store", "key response"),
    r2Ticket: stringField(data, "r2_ticket", "key response"),
  };
}

export interface ShareGrantRequest {
  dbPath: string;
  dbPrefix: string;
  sharePrefix: string;
  sharePath: string;
  shareId: string;
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
