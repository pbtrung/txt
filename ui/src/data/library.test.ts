import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64, randomBytes } from "../crypto/bytes";
import { loadLibrary, type LibrarySession } from "./library";
import { wrapMetadataCatalog } from "./metadata";

const umk = randomBytes(128);

function fakeSession(overrides: Partial<LibrarySession> = {}): LibrarySession {
  return { authId: "auth-1", umk, ...overrides };
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

async function sharedTxtRow(id: string, name: string, title = name) {
  const rootKey = randomBytes(128);
  const userTxtKeyBlob = await blob.encrypt(umk, rootKey);
  const catalogPayload = {
    name,
    title,
    authors: [],
    subjects: [],
    publishers: [],
  };
  return {
    id,
    userTxtKey: bytesToBase64(userTxtKeyBlob),
    sharedTxtMetadata: [
      { catalog: await wrapMetadataCatalog(rootKey, catalogPayload) },
    ],
  };
}

function fakeDb(txt: unknown[], sharedTxt: unknown[] = []) {
  return {
    queryOnce: vi.fn(async (query: any) => {
      if (query.txt) {
        return { data: { txt: query.txt.$.offset === 0 ? txt : [] } };
      }
      return {
        data: {
          sharedTxt: query.sharedTxt.$.offset === 0 ? sharedTxt : [],
        },
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

    const { metadataById, docKeys, docKinds } = await loadLibrary(db, session);

    expect(metadataById.get("txt-1")?.title).toBe("Doc One");
    expect(metadataById.get("txt-1")?.name).toBe("doc-one.txt");
    expect(metadataById.get("txt-1")?.author).toBe("Author One");
    expect(metadataById.get("txt-1")?.rawMetadata).toEqual([]);
    expect(docKeys.get("txt-1")).toBeInstanceOf(Uint8Array);
    expect(docKinds.get("txt-1")).toBe("txt");
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

  it("loads a shared document by decrypting sharedTxt's own userTxtKey under this account's umk", async () => {
    const row = await sharedTxtRow("share-1", "shared.txt");
    const db = fakeDb([], [row]);
    const session = fakeSession();

    const { metadataById, docKeys, docKinds } = await loadLibrary(db, session);

    expect(metadataById.get("share-1")?.name).toBe("shared.txt");
    expect(docKeys.get("share-1")).toBeInstanceOf(Uint8Array);
    expect(docKinds.get("share-1")).toBe("sharedTxt");
  });

  it("combines owned and shared documents into one snapshot", async () => {
    const ownedRow = await ownedTxtRow("txt-owned", "owned.txt");
    const sharedRow = await sharedTxtRow("share-1", "shared.txt");
    const db = fakeDb([ownedRow], [sharedRow]);
    const session = fakeSession();

    const { metadataById } = await loadLibrary(db, session);

    expect(Array.from(metadataById.keys()).sort()).toEqual([
      "share-1",
      "txt-owned",
    ]);
  });

  it("skips a sharedTxt row missing its own sharedTxtMetadata rather than throwing", async () => {
    const row = await sharedTxtRow("share-1", "shared.txt");
    const rowWithNoMetadata = { ...row, sharedTxtMetadata: [] };
    const db = fakeDb([], [rowWithNoMetadata]);

    const { metadataById } = await loadLibrary(db, fakeSession());

    expect(metadataById.size).toBe(0);
  });
});
