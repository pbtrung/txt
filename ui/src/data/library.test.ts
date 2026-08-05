import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64, concatBytes, randomBytes } from "../crypto/bytes";
import { SALT_LEN } from "../crypto/constants";
import { kemEncapsulate, kemKeypair } from "./leancrypto";
import { loadLibrary } from "./library";
import { wrapMetadataCatalog } from "./metadata";
import type { Session } from "./session";

const umk = randomBytes(128);

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    authId: "auth-1",
    isAdmin: false,
    umk,
    keyStorePrivKey: new Uint8Array(3224),
    credStoreKey: randomBytes(128),
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

async function ownedTxtRow(
  id: string,
  name: string,
  author?: string,
  title = name,
) {
  const txtKey = randomBytes(128);
  const txtKeyBlob = await blob.encrypt(umk, txtKey);
  const catalogPayload = {
    name,
    title,
    authors: author ? [author] : [],
    subjects: [],
    publishers: [],
  };
  return {
    id,
    txtKey: bytesToBase64(txtKeyBlob),
    txtMetadata: [
      { catalog: await wrapMetadataCatalog(txtKey, catalogPayload) },
    ],
  };
}

async function sharedTxtSharesRow(txtId: string, name: string, title = name) {
  const { pubKey, privKey } = await kemKeypair();
  const txtKey = randomBytes(128);
  const { ct, ss } = await kemEncapsulate(pubKey);
  // crypto.md's Encapsulate step 3: reuse the salt embedded in the returned
  // blob's own header as saltKemCt's own salt half -- extract it after
  // encrypting, same as txtShares.saltKemCt/txtKey really carry.
  const txtKeyBlob = await blob.encrypt(ss, txtKey);
  const salt = txtKeyBlob.slice(4, 4 + SALT_LEN); // magic(2)+version(2) header, then salt
  const saltKemCt = concatBytes(salt, ct);

  const catalogPayload = {
    name,
    title,
    authors: [],
    subjects: [],
    publishers: [],
  };
  return {
    row: {
      saltKemCt: bytesToBase64(saltKemCt),
      txtKey: bytesToBase64(txtKeyBlob),
      txt: [
        {
          id: txtId,
          txtMetadata: [
            { catalog: await wrapMetadataCatalog(txtKey, catalogPayload) },
          ],
        },
      ],
    },
    privKey,
  };
}

function fakeDb(txt: unknown[], txtShares: unknown[] = []) {
  return {
    queryOnce: vi.fn(async (query: any) => {
      if (query.txt) {
        return { data: { txt: query.txt.$.offset === 0 ? txt : [] } };
      }
      return {
        data: { txtShares: query.txtShares.$.offset === 0 ? txtShares : [] },
      };
    }),
  };
}

describe("loadLibrary", () => {
  it("loads owned documents, decrypting txtKey under umk and catalog under txtKey", async () => {
    const row = await ownedTxtRow(
      "txt-1",
      "doc-one.txt",
      "Author One",
      "Doc One",
    );
    const db = fakeDb([row]);
    const session = fakeSession();

    const { metadataById, docKeys } = await loadLibrary(db, session);

    expect(metadataById.get("txt-1")?.title).toBe("Doc One");
    expect(metadataById.get("txt-1")?.name).toBe("doc-one.txt");
    expect(metadataById.get("txt-1")?.author).toBe("Author One");
    expect(metadataById.get("txt-1")?.rawMetadata).toEqual([]);
    expect(docKeys.get("txt-1")).toBeInstanceOf(Uint8Array);
    expect(db.queryOnce.mock.calls[0]![0].txt.txtMetadata.$.fields).toEqual([
      "catalog",
    ]);
    expect(db.queryOnce.mock.calls[0]![0].txt.$.fields).toEqual(["txtKey"]);
    expect(db.queryOnce.mock.calls[0]![0].txt.$.limit).toBe(1500);
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
