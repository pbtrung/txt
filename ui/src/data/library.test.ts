import { describe, expect, it } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64, concatBytes, randomBytes } from "../crypto/bytes";
import { SALT_LEN } from "../crypto/constants";
import { kemEncapsulate, kemKeypair } from "./leancrypto";
import { loadLibrary } from "./library";
import type { Session } from "./session";

const umk = randomBytes(128);

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    authId: "auth-1",
    umk,
    keyStorePrivKey: new Uint8Array(3224),
    r2Config: {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "my-bucket",
    },
    txtAccess: { id: null, key: randomBytes(128), content: {} },
    txtBookmarks: { id: null, key: randomBytes(128), content: {} },
    ...overrides,
  };
}

async function ownedTxtRow(id: string, name: string, opfTitle?: string) {
  const txtKey = randomBytes(128);
  const txtKeyBlob = await blob.encrypt(umk, txtKey);
  const contentPayload = {
    name,
    metadata: opfTitle ? { title: opfTitle } : {},
  };
  const contentBlob = await blob.encrypt(
    txtKey,
    new TextEncoder().encode(JSON.stringify(contentPayload)),
    { compressed: true },
  );
  return {
    id,
    txtKey: bytesToBase64(txtKeyBlob),
    txtMetadata: [{ content: bytesToBase64(contentBlob) }],
  };
}

async function sharedTxtSharesRow(txtId: string, name: string) {
  const { pubKey, privKey } = await kemKeypair();
  const txtKey = randomBytes(128);
  const { ct, ss } = await kemEncapsulate(pubKey);
  // crypto.md's Encapsulate step 3: reuse the salt embedded in the returned
  // blob's own header as saltKemCt's own salt half -- extract it after
  // encrypting, same as txtShares.saltKemCt/txtKey really carry.
  const txtKeyBlob = await blob.encrypt(ss, txtKey);
  const salt = txtKeyBlob.slice(4, 4 + SALT_LEN); // magic(2)+version(2) header, then salt
  const saltKemCt = concatBytes(salt, ct);

  const contentPayload = { name, metadata: {} };
  const contentBlob = await blob.encrypt(
    txtKey,
    new TextEncoder().encode(JSON.stringify(contentPayload)),
    { compressed: true },
  );
  return {
    row: {
      saltKemCt: bytesToBase64(saltKemCt),
      txtKey: bytesToBase64(txtKeyBlob),
      txt: [
        { id: txtId, txtMetadata: [{ content: bytesToBase64(contentBlob) }] },
      ],
    },
    privKey,
  };
}

function fakeDb(txt: unknown[], txtShares: unknown[] = []) {
  return {
    queryOnce: async (query: any) => {
      if (query.txt) {
        return { data: { txt: query.txt.$.offset === 0 ? txt : [] } };
      }
      return {
        data: { txtShares: query.txtShares.$.offset === 0 ? txtShares : [] },
      };
    },
  };
}

describe("loadLibrary", () => {
  it("loads owned documents, decrypting txtKey under umk and metadata under txtKey", async () => {
    const row = await ownedTxtRow("txt-1", "doc-one.txt", "Real Title");
    const db = fakeDb([row]);
    const session = fakeSession();

    const { metadataById, docKeys } = await loadLibrary(db, session);

    expect(metadataById.get("txt-1")?.title).toBe("Real Title");
    expect(metadataById.get("txt-1")?.name).toBe("doc-one.txt");
    expect(docKeys.get("txt-1")).toBeInstanceOf(Uint8Array);
  });

  it("falls back to name when there's no OPF title", async () => {
    const row = await ownedTxtRow("txt-2", "doc-two.txt");
    const db = fakeDb([row]);

    const { metadataById } = await loadLibrary(db, fakeSession());

    expect(metadataById.get("txt-2")?.title).toBe("doc-two.txt");
  });

  it("loads a shared document by Decapsulating txtShares' own txtKey", async () => {
    const { row, privKey } = await sharedTxtSharesRow(
      "txt-shared-1",
      "shared.txt",
    );
    const db = fakeDb([], [row]);
    const session = fakeSession({ keyStorePrivKey: privKey });

    const { metadataById, docKeys } = await loadLibrary(db, session);

    expect(metadataById.get("txt-shared-1")?.name).toBe("shared.txt");
    expect(docKeys.get("txt-shared-1")).toBeInstanceOf(Uint8Array);
  });

  it("combines owned and shared documents into one snapshot", async () => {
    const ownedRow = await ownedTxtRow("txt-owned", "owned.txt");
    const { row: sharedRow, privKey } = await sharedTxtSharesRow(
      "txt-shared",
      "shared.txt",
    );
    const db = fakeDb([ownedRow], [sharedRow]);
    const session = fakeSession({ keyStorePrivKey: privKey });

    const { metadataById } = await loadLibrary(db, session);

    expect(Array.from(metadataById.keys()).sort()).toEqual([
      "txt-owned",
      "txt-shared",
    ]);
  });

  it("skips a shared txtShares row whose own txt is inaccessible/gone rather than throwing", async () => {
    const { row } = await sharedTxtSharesRow("txt-shared", "shared.txt");
    const rowWithNoTxt = { ...row, txt: [] };
    const db = fakeDb([], [rowWithNoTxt]);

    const { metadataById } = await loadLibrary(db, fakeSession());

    expect(metadataById.size).toBe(0);
  });
});
