import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccessRequiredError,
  AccessVersionConflictError,
  ApiClient,
} from "../../src/data/apiClient";
import type { OwnerSigningIdentity } from "../../src/data/ownerProof";
import { toBase64 } from "../../src/util/base64";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as Response;
}

function htmlResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "text/html" }),
    json: async () => {
      throw new Error("not json");
    },
  } as Response;
}

afterEach(() => vi.unstubAllGlobals());

async function testSigning(): Promise<OwnerSigningIdentity> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-521" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    ticket: "header.payload.signature",
    userHandle: new Uint8Array(32).fill(3),
    privateKey: pair.privateKey,
  };
}

describe("ApiClient Access-challenge detection", () => {
  it("treats a non-JSON response as AccessRequiredError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse()));
    await expect(new ApiClient().fetchOwner()).rejects.toBeInstanceOf(
      AccessRequiredError,
    );
  });

  it("treats a fetch() failure as AccessRequiredError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(new ApiClient().fetchOwner()).rejects.toBeInstanceOf(
      AccessRequiredError,
    );
  });
});

describe("ApiClient reads", () => {
  it("parses the owner record", async () => {
    const bytes = toBase64(new Uint8Array([1, 2, 3]));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          wrapped_umk: bytes,
          sign_public_key: bytes,
          wrapped_sign_private_key: bytes,
          kem_public_key: bytes,
          wrapped_kem_private_key: bytes,
          encrypted_credentials: bytes,
          ticket: "t",
        }),
      ),
    );
    const owner = await new ApiClient().fetchOwner();
    expect(owner.ticket).toBe("t");
    expect([...owner.wrappedUmk]).toEqual([1, 2, 3]);
  });

  it("parses documents", async () => {
    const bytes = toBase64(new Uint8Array([1]));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          documents: [
            {
              id: 1,
              created_at: 0,
              content_blob: bytes,
              content_key_wrapped: bytes,
              access_blob: bytes,
              access_version: 0,
              access_key_wrapped: bytes,
            },
          ],
        }),
      ),
    );
    const documents = await new ApiClient().fetchDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(1);
  });

  it("parses a null catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { catalog: null })),
    );
    await expect(new ApiClient().fetchCatalog()).resolves.toBeNull();
  });

  it("fetches bookmarks with the document_id query param", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { bookmarks: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await new ApiClient().fetchBookmarks(42);
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/bookmarks?document_id=42");
  });
});

describe("ApiClient proofed mutations", () => {
  it("sends the ticket and proof headers with the exact signed body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { access_version: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const signing = await testSigning();

    await new ApiClient().updateDocumentAccess(
      5,
      new Uint8Array([9, 9]),
      0,
      signing,
      "a".repeat(52),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/documents/5/access");
    expect(init.method).toBe("PATCH");
    expect(init.headers["X-Owner-Ticket"]).toBe(signing.ticket);
    const proof = JSON.parse(init.headers["X-Owner-Proof"]);
    expect(proof.version).toBe(1);
    expect(init.body).toEqual(
      new TextEncoder().encode(
        JSON.stringify({
          access_blob: toBase64(new Uint8Array([9, 9])),
          access_version: 0,
          user_handle: toBase64(signing.userHandle),
          db_prefix: "a".repeat(52),
        }),
      ),
    );
  });

  it("throws AccessVersionConflictError on 412", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(412, {})));
    const signing = await testSigning();
    await expect(
      new ApiClient().updateDocumentAccess(
        5,
        new Uint8Array(),
        0,
        signing,
        "a".repeat(52),
      ),
    ).rejects.toBeInstanceOf(AccessVersionConflictError);
  });

  it("registers a share and returns the grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { registered: true, grant: "g" })),
    );
    const signing = await testSigning();
    await expect(
      new ApiClient().createShare(
        {
          documentId: 1,
          shareId: "id",
          sharePath: "path",
          keyWrapped: new Uint8Array([1]),
          ownerBlob: new Uint8Array([2]),
        },
        signing,
        "a".repeat(52),
      ),
    ).resolves.toBe("g");
  });
});
