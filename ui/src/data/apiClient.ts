import type { FirebaseTokenProvider } from "../auth/firebaseSignIn";
import { toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";
import { withNetworkRetries } from "./networkRequest";
import {
  P521_SIGNATURE_BYTES,
  R2_TICKET_PROOF_VERSION,
  canonicalR2TicketProof,
} from "./r2Proof";

const PROOF_LIFETIME_SECONDS = 45;

export interface OwnerTicket {
  uid: string;
  ticket: string;
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

export interface ShareRegistration {
  dbPath: string;
  dbPrefix: string;
  sharePrefix: string;
  sharePath: string;
  shareId: string;
}

export class ApiClient {
  readonly baseUrl: string;

  constructor(
    private readonly tokens: FirebaseTokenProvider,
    baseUrl: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async fetchOwnerTicket(signal?: AbortSignal): Promise<OwnerTicket> {
    const response = await this.authenticatedRequest(
      "/v1/keys",
      "POST",
      undefined,
      signal,
    );
    if (response.status === 403) {
      throw new Error("Firebase account is not the configured owner");
    }
    if (!response.ok)
      throw new Error(`could not obtain owner ticket: ${response.status}`);
    return parseOwnerTicket(await response.json());
  }

  async fetchR2Token(
    dbPath: string,
    dbPrefix: string,
    signing: R2SigningIdentity,
    signal?: AbortSignal,
  ): Promise<R2CredentialPair> {
    let response = await this.signedR2Request(dbPath, dbPrefix, signing, signal);
    if (response.status === 401) {
      signing.ticket = (await this.fetchOwnerTicket(signal)).ticket;
      response = await this.signedR2Request(dbPath, dbPrefix, signing, signal);
    }
    if (!response.ok) {
      throw new Error(`could not obtain R2 credentials: ${response.status}`);
    }
    return parseR2CredentialPair(await response.json());
  }

  async registerShare(request: ShareRegistration): Promise<string> {
    return withNetworkRetries(async (signal) => {
      const response = await this.authenticatedRequest(
        "/v1/shares",
        "POST",
        shareBody(request),
        signal,
      );
      if (!response.ok) {
        throw new Error(`could not register share: ${response.status}`);
      }
      const data = objectRecord(await response.json(), "share registration response");
      return stringField(data, "grant", "share registration response");
    });
  }

  async deleteShare(request: ShareRegistration): Promise<void> {
    await withNetworkRetries(async (signal) => {
      const response = await this.authenticatedRequest(
        "/v1/shares",
        "DELETE",
        shareBody(request),
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
    const proof = await signedProof(dbPath, dbPrefix, signing);
    return fetch(this.url("/v1/r2-token"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: signing.ticket,
        user_handle: toBase64(signing.userHandle),
        db_path: dbPath,
        db_prefix: dbPrefix,
        proof,
      }),
      signal,
    });
  }

  private async authenticatedRequest(
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response = await this.authorizedRequest(path, method, false, body, signal);
    if (response.status === 401) {
      response = await this.authorizedRequest(path, method, true, body, signal);
    }
    return response;
  }

  private async authorizedRequest(
    path: string,
    method: string,
    forceRefresh: boolean,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const idToken = await this.tokens.getIdToken(forceRefresh, signal);
    return fetch(this.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  }

  private url(path: string): string {
    return this.baseUrl + path;
  }
}

async function signedProof(
  dbPath: string,
  dbPrefix: string,
  signing: R2SigningIdentity,
) {
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
    throw new Error(`Web Crypto returned an invalid P-521 signature size`);
  }
  return {
    version: R2_TICKET_PROOF_VERSION,
    expires_at: expiresAt,
    request_id: toBase64(requestId),
    signature: toBase64(signature),
  };
}

function parseOwnerTicket(value: unknown): OwnerTicket {
  const data = objectRecord(value, "owner ticket response");
  return {
    uid: stringField(data, "uid", "owner ticket response"),
    ticket: stringField(data, "r2_ticket", "owner ticket response"),
  };
}

function shareBody(request: ShareRegistration) {
  return {
    db_path: request.dbPath,
    db_prefix: request.dbPrefix,
    share_prefix: request.sharePrefix,
    share_path: request.sharePath,
    share_id: request.shareId,
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
  const parsed = data.credentials.map((value) => parseTypedCredential(value, common));
  const dbPath = oneCredential(parsed, "db_path");
  const dbPrefix = oneCredential(parsed, "db_prefix");
  return { dbPath, dbPrefix };
}

function parseTypedCredential(
  value: unknown,
  common: Pick<R2TempCredential, "endpoint" | "bucket" | "region">,
) {
  const data = objectRecord(value, "R2 credential");
  return {
    type: stringField(data, "type", "R2 credential"),
    credential: parseR2Credential(data, common),
  };
}

function oneCredential(
  values: ReturnType<typeof parseTypedCredential>[],
  type: "db_path" | "db_prefix",
): R2TempCredential {
  const matches = values.filter((value) => value.type === type);
  if (
    matches.length !== 1 ||
    values.some((value) => !["db_path", "db_prefix"].includes(value.type))
  ) {
    throw new Error("R2 credential response has missing, duplicate, or unknown types");
  }
  return matches[0].credential;
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
