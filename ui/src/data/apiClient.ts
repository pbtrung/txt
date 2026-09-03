// Thin REST wrapper over the Worker's /v1/* routes (docs/auth.md,
// docs/data_model.md §3, docs/sharing.md). Same-origin fetch() carries the
// Cloudflare Access session cookie automatically -- there is no
// UI-driven sign-in step. Every mutating call signs a fresh proof
// (ownerProof.ts) over the exact body bytes it sends.
import type { OwnerSigningIdentity } from "./ownerProof";
import { signOwnerProof } from "./ownerProof";
import { withNetworkRetries } from "./networkRequest";
import { fromBase64, toBase64 } from "../util/base64";
import { objectRecord, stringField } from "../util/validation";

const TICKET_HEADER = "X-Owner-Ticket";
const PROOF_HEADER = "X-Owner-Proof";

/** docs/auth.md §1: an unauthenticated request to a gated /v1/* path never
 * reaches the Worker -- Access intercepts it with its own login
 * challenge, either a redirect response (to a different, Access-owned
 * origin) or, if fetch() tries to follow that redirect cross-origin, a
 * network-level failure. Both surface here as "not logged in, prompt to
 * authenticate" rather than a decodable API error. A same-origin,
 * non-redirected response is never an Access challenge, even when its
 * body isn't JSON -- that's the Worker's own plain-text error response
 * (e.g. requireProof.ts's `new Response(message, {status})`), and must
 * surface as the real error instead of being mistaken for a missing
 * Access session. */
export class AccessRequiredError extends Error {
  constructor() {
    super("Cloudflare Access session required");
    this.name = "AccessRequiredError";
  }
}

export class AccessVersionConflictError extends Error {
  constructor() {
    super("access_version conflict");
    this.name = "AccessVersionConflictError";
  }
}

export interface OwnerRecord {
  wrappedUmk: Uint8Array;
  signPublicKey: Uint8Array;
  wrappedSignPrivateKey: Uint8Array;
  kemPublicKey: Uint8Array;
  wrappedKemPrivateKey: Uint8Array;
  encryptedCredentials: Uint8Array;
  ticket: string;
}

export interface DocumentRow {
  id: number;
  createdAt: number;
  contentBlob: Uint8Array;
  contentKeyWrapped: Uint8Array;
  accessBlob: Uint8Array;
  accessVersion: number;
  accessKeyWrapped: Uint8Array;
}

export interface CatalogRow {
  keyWrapped: Uint8Array;
  catalogBlob: Uint8Array;
}

export interface BookmarkRow {
  id: number;
  createdAt: number;
  keyWrapped: Uint8Array;
  bookmarkBlob: Uint8Array;
}

export interface BookmarkSummaryRow {
  id: number;
  documentId: number;
  count: number;
  keyWrapped: Uint8Array;
  bookmarkBlob: Uint8Array;
  createdAt: number;
}

export interface ShareRow {
  shareIdHash: Uint8Array;
  documentId: number;
  keyWrapped: Uint8Array;
  ownerBlob: Uint8Array;
  state: "creating" | "active" | "deleting";
  createdAt: number;
}

export interface R2TempCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export interface R2CredentialSet {
  endpoint: string;
  bucket: string;
  expiresAt: number;
  documents: R2TempCredential;
  catalog: R2TempCredential;
}

async function fetchSameOrigin(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    // A cross-origin failure following Access's own redirect surfaces as a
    // generic fetch TypeError, indistinguishable at this layer from a
    // transient network error (offline, DNS, connection reset) -- both
    // throw the exact same shape. withNetworkRetries() gives the transient
    // case a real chance to recover before either is treated as "not
    // logged in" below; a persistent failure either way still ends up
    // there once retries are exhausted, per docs/auth.md §1.
    response = await withNetworkRetries(() => fetch(path, init));
  } catch {
    throw new AccessRequiredError();
  }
  if (isAccessChallenge(response)) {
    throw new AccessRequiredError();
  }
  return response;
}

/** True only for a response that actually left this origin (a redirect,
 * or a final URL on a different origin) and isn't JSON -- the shape of
 * Access's own login challenge, per docs/auth.md §1. A same-origin,
 * non-redirected response is always the Worker's own, whatever its
 * content-type or status. */
function isAccessChallenge(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return false;
  if (response.redirected) return true;
  if (typeof window === "undefined") return false;
  return new URL(response.url, window.location.href).origin !== window.location.origin;
}

export class ApiClient {
  constructor(private readonly baseUrl: string = "") {}

  async fetchOwner(signal?: AbortSignal): Promise<OwnerRecord> {
    const response = await this.get("/v1/owner", signal);
    if (!response.ok)
      throw new Error(`could not fetch owner record: ${response.status}`);
    return parseOwnerRecord(await response.json());
  }

  async fetchDocuments(signal?: AbortSignal): Promise<DocumentRow[]> {
    const response = await this.get("/v1/documents", signal);
    if (!response.ok) throw new Error(`could not fetch documents: ${response.status}`);
    const data = objectRecord(await response.json(), "documents response");
    if (!Array.isArray(data.documents)) {
      throw new Error("documents response is missing documents");
    }
    return data.documents.map(parseDocumentRow);
  }

  async fetchCatalog(signal?: AbortSignal): Promise<CatalogRow | null> {
    const response = await this.get("/v1/catalog", signal);
    if (!response.ok) throw new Error(`could not fetch catalog: ${response.status}`);
    const data = objectRecord(await response.json(), "catalog response");
    return data.catalog === null ? null : parseCatalogRow(data.catalog);
  }

  async fetchBookmarks(
    documentId: number,
    signal?: AbortSignal,
  ): Promise<BookmarkRow[]> {
    const response = await this.get(
      `/v1/bookmarks?${new URLSearchParams({ document_id: String(documentId) })}`,
      signal,
    );
    if (!response.ok) throw new Error(`could not fetch bookmarks: ${response.status}`);
    const data = objectRecord(await response.json(), "bookmarks response");
    if (!Array.isArray(data.bookmarks)) {
      throw new Error("bookmarks response is missing bookmarks");
    }
    return data.bookmarks.map(parseBookmarkRow);
  }

  async fetchBookmarksSummary(signal?: AbortSignal): Promise<BookmarkSummaryRow[]> {
    const response = await this.get("/v1/bookmarks/summary", signal);
    if (!response.ok) {
      throw new Error(`could not fetch bookmarks summary: ${response.status}`);
    }
    const data = objectRecord(await response.json(), "bookmarks summary response");
    if (!Array.isArray(data.summaries)) {
      throw new Error("bookmarks summary response is missing summaries");
    }
    return data.summaries.map(parseBookmarkSummaryRow);
  }

  async fetchShares(signal?: AbortSignal): Promise<ShareRow[]> {
    const response = await this.get("/v1/shares", signal);
    if (!response.ok) throw new Error(`could not fetch shares: ${response.status}`);
    const data = objectRecord(await response.json(), "shares response");
    if (!Array.isArray(data.shares)) {
      throw new Error("shares response is missing shares");
    }
    return data.shares.map(parseShareRow);
  }

  async fetchR2Credentials(
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    signal?: AbortSignal,
  ): Promise<R2CredentialSet> {
    const response = await this.proofed(
      "POST",
      "/v1/r2-credentials",
      signing,
      dbPrefix,
      {},
      signal,
    );
    if (!response.ok) {
      throw new Error(`could not obtain R2 credentials: ${response.status}`);
    }
    return parseR2CredentialSet(await response.json());
  }

  async updateDocumentAccess(
    id: number,
    accessBlob: Uint8Array,
    accessVersion: number,
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.proofed(
      "PATCH",
      `/v1/documents/${id}/access`,
      signing,
      dbPrefix,
      { access_blob: toBase64(accessBlob), access_version: accessVersion },
      signal,
    );
    if (response.status === 412) throw new AccessVersionConflictError();
    if (!response.ok) {
      throw new Error(`could not update reading position: ${response.status}`);
    }
    const data = objectRecord(await response.json(), "access update response");
    return numberField(data, "access_version", "access update response");
  }

  async createBookmark(
    documentId: number,
    keyWrapped: Uint8Array,
    bookmarkBlob: Uint8Array,
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.proofed(
      "POST",
      "/v1/bookmarks",
      signing,
      dbPrefix,
      {
        document_id: documentId,
        key_wrapped: toBase64(keyWrapped),
        bookmark_blob: toBase64(bookmarkBlob),
      },
      signal,
    );
    if (!response.ok) throw new Error(`could not save bookmark: ${response.status}`);
    const data = objectRecord(await response.json(), "bookmark response");
    return numberField(data, "id", "bookmark response");
  }

  async deleteBookmark(
    id: number,
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.proofed(
      "DELETE",
      `/v1/bookmarks/${id}`,
      signing,
      dbPrefix,
      {},
      signal,
    );
    if (!response.ok) throw new Error(`could not delete bookmark: ${response.status}`);
  }

  async createShare(
    fields: {
      documentId: number;
      shareId: string;
      sharePath: string;
      keyWrapped: Uint8Array;
      ownerBlob: Uint8Array;
    },
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.proofed(
      "POST",
      "/v1/shares",
      signing,
      dbPrefix,
      {
        document_id: fields.documentId,
        share_id: fields.shareId,
        share_path: fields.sharePath,
        key_wrapped: toBase64(fields.keyWrapped),
        owner_blob: toBase64(fields.ownerBlob),
      },
      signal,
    );
    if (!response.ok) throw new Error(`could not register share: ${response.status}`);
    const data = objectRecord(await response.json(), "share response");
    return stringField(data, "grant", "share response");
  }

  async deleteShare(
    fields: { documentId: number; shareId: string; sharePath: string },
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.proofed(
      "DELETE",
      "/v1/shares",
      signing,
      dbPrefix,
      {
        document_id: fields.documentId,
        share_id: fields.shareId,
        share_path: fields.sharePath,
      },
      signal,
    );
    if (!response.ok) throw new Error(`could not delete share: ${response.status}`);
  }

  private async get(path: string, signal?: AbortSignal): Promise<Response> {
    return fetchSameOrigin(this.url(path), { signal });
  }

  private async proofed(
    method: string,
    path: string,
    signing: OwnerSigningIdentity,
    dbPrefix: string,
    bodyFields: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const { envelope, body } = await signOwnerProof(
      signing,
      dbPrefix,
      method,
      path,
      bodyFields,
    );
    return fetchSameOrigin(this.url(path), {
      method,
      headers: {
        "Content-Type": "application/json",
        [TICKET_HEADER]: signing.ticket,
        [PROOF_HEADER]: JSON.stringify(envelope),
      },
      body: new Uint8Array(body),
      signal,
    });
  }

  private url(path: string): string {
    return this.baseUrl + path;
  }
}

function numberField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`${label} is missing ${key}`);
  return value;
}

function bytesField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): Uint8Array {
  return fromBase64(stringField(record, key, label));
}

function parseOwnerRecord(value: unknown): OwnerRecord {
  const data = objectRecord(value, "owner response");
  return {
    wrappedUmk: bytesField(data, "wrapped_umk", "owner response"),
    signPublicKey: bytesField(data, "sign_public_key", "owner response"),
    wrappedSignPrivateKey: bytesField(
      data,
      "wrapped_sign_private_key",
      "owner response",
    ),
    kemPublicKey: bytesField(data, "kem_public_key", "owner response"),
    wrappedKemPrivateKey: bytesField(data, "wrapped_kem_private_key", "owner response"),
    encryptedCredentials: bytesField(data, "encrypted_credentials", "owner response"),
    ticket: stringField(data, "ticket", "owner response"),
  };
}

function parseDocumentRow(value: unknown): DocumentRow {
  const data = objectRecord(value, "document row");
  return {
    id: numberField(data, "id", "document row"),
    createdAt: numberField(data, "created_at", "document row"),
    contentBlob: bytesField(data, "content_blob", "document row"),
    contentKeyWrapped: bytesField(data, "content_key_wrapped", "document row"),
    accessBlob: bytesField(data, "access_blob", "document row"),
    accessVersion: numberField(data, "access_version", "document row"),
    accessKeyWrapped: bytesField(data, "access_key_wrapped", "document row"),
  };
}

function parseCatalogRow(value: unknown): CatalogRow {
  const data = objectRecord(value, "catalog row");
  return {
    keyWrapped: bytesField(data, "key_wrapped", "catalog row"),
    catalogBlob: bytesField(data, "catalog_blob", "catalog row"),
  };
}

function parseBookmarkRow(value: unknown): BookmarkRow {
  const data = objectRecord(value, "bookmark row");
  return {
    id: numberField(data, "id", "bookmark row"),
    createdAt: numberField(data, "created_at", "bookmark row"),
    keyWrapped: bytesField(data, "key_wrapped", "bookmark row"),
    bookmarkBlob: bytesField(data, "bookmark_blob", "bookmark row"),
  };
}

function parseBookmarkSummaryRow(value: unknown): BookmarkSummaryRow {
  const data = objectRecord(value, "bookmark summary row");
  return {
    id: numberField(data, "id", "bookmark summary row"),
    documentId: numberField(data, "document_id", "bookmark summary row"),
    count: numberField(data, "count", "bookmark summary row"),
    keyWrapped: bytesField(data, "key_wrapped", "bookmark summary row"),
    bookmarkBlob: bytesField(data, "bookmark_blob", "bookmark summary row"),
    createdAt: numberField(data, "created_at", "bookmark summary row"),
  };
}

function parseShareRow(value: unknown): ShareRow {
  const data = objectRecord(value, "share row");
  const state = stringField(data, "state", "share row");
  if (state !== "creating" && state !== "active" && state !== "deleting") {
    throw new Error("share row has an invalid state");
  }
  return {
    shareIdHash: bytesField(data, "share_id_hash", "share row"),
    documentId: numberField(data, "document_id", "share row"),
    keyWrapped: bytesField(data, "key_wrapped", "share row"),
    ownerBlob: bytesField(data, "owner_blob", "share row"),
    state,
    createdAt: numberField(data, "created_at", "share row"),
  };
}

function parseR2CredentialSet(value: unknown): R2CredentialSet {
  const data = objectRecord(value, "R2 credential response");
  return {
    endpoint: stringField(data, "endpoint", "R2 credential response"),
    bucket: stringField(data, "bucket", "R2 credential response"),
    expiresAt: numberField(data, "expires_at", "R2 credential response"),
    documents: parseR2TempCredential(data, "documents"),
    catalog: parseR2TempCredential(data, "catalog"),
  };
}

function parseR2TempCredential(
  data: Record<string, unknown>,
  key: "documents" | "catalog",
): R2TempCredential {
  const credential = objectRecord(data[key], `R2 credential response ${key}`);
  return {
    accessKeyId: stringField(credential, "access_key_id", "R2 credential"),
    secretAccessKey: stringField(credential, "secret_access_key", "R2 credential"),
    sessionToken: stringField(credential, "session_token", "R2 credential"),
  };
}
