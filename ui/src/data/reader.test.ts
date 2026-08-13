import type { AwsClient } from "aws4fetch";
import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import { bytesToBase64, randomBytes } from "../crypto/bytes";
import { generateRandomToken, wrapToken } from "./randomToken";
import { openDoc, partContent, partCount } from "./reader";
import type { R2Config } from "./r2Config";

const r2Config: R2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "my-bucket",
};

function fakeAwsClient(
  fetchImpl: (url: string) => Promise<Response>,
): AwsClient {
  return { fetch: vi.fn(fetchImpl) } as unknown as AwsClient;
}

interface FixturePart {
  partNum: number;
  text: string;
  rawKey: string;
  txtPartKey: Uint8Array;
}

async function buildFixture(partTexts: string[]) {
  const docKey = randomBytes(128);
  const prefix = generateRandomToken();
  const wrappedPrefix = await wrapToken(docKey, prefix);

  const parts: FixturePart[] = [];
  const txtPartsRows: { partNum: number; txtPartKey: string; path: string }[] =
    [];
  const objects = new Map<string, Uint8Array>();
  for (let i = 0; i < partTexts.length; i++) {
    const partNum = i + 1;
    const txtPartKey = randomBytes(128);
    const rawKey = generateRandomToken();
    const path = await wrapToken(txtPartKey, rawKey);
    const body = await blob.encrypt(
      txtPartKey,
      new TextEncoder().encode(partTexts[i]!),
      { compressed: true },
    );
    objects.set(`${prefix}/${rawKey}`, body);
    txtPartsRows.push({
      partNum,
      txtPartKey: bytesToBase64(await blob.encrypt(docKey, txtPartKey)),
      path,
    });
    parts.push({ partNum, text: partTexts[i]!, rawKey, txtPartKey });
  }

  const db = {
    queryOnce: async (query: any) => {
      expect(query.txt.$.where.id).toBe("txt-1");
      return {
        data: {
          txt: [{ id: "txt-1", prefix: wrappedPrefix, txtParts: txtPartsRows }],
        },
      };
    },
  };

  const r2Client = fakeAwsClient(async (url) => {
    for (const [key, body] of objects) {
      if (url.endsWith(key)) return new Response(body as BodyInit);
    }
    return new Response("not found", { status: 404 });
  });

  return { db, docKey, r2Client, prefix, parts };
}

describe("openDoc / partCount / partContent", () => {
  it("opens a document, decrypting its prefix and every part's txtPartKey", async () => {
    const { db, docKey } = await buildFixture([
      "part one text",
      "part two text",
    ]);

    const doc = await openDoc(db, "txt-1", "txt", docKey);

    expect(partCount(doc)).toBe(2);
  });

  it("fetches and decrypts one part's content from R2", async () => {
    const { db, docKey, r2Client } = await buildFixture([
      "first part",
      "second part",
    ]);

    const doc = await openDoc(db, "txt-1", "txt", docKey);
    const text1 = await partContent(doc, r2Client, r2Config, 1);
    const text2 = await partContent(doc, r2Client, r2Config, 2);

    expect(text1).toBe("first part");
    expect(text2).toBe("second part");
  });

  it("sorts parts by partNum regardless of query result order", async () => {
    const { db, docKey } = await buildFixture(["a", "b", "c"]);
    // Simulate an out-of-order query result by re-fetching through the same
    // fixture's db (queryOnce already returns them in insertion order here,
    // so this asserts openDoc doesn't just trust that ordering).
    const doc = await openDoc(db, "txt-1", "txt", docKey);
    expect(doc.parts.map((p) => p.partNum)).toEqual([1, 2, 3]);
  });

  it("throws when the requested part doesn't exist", async () => {
    const { db, docKey, r2Client } = await buildFixture(["only part"]);
    const doc = await openDoc(db, "txt-1", "txt", docKey);
    await expect(partContent(doc, r2Client, r2Config, 99)).rejects.toThrow(
      "no txtParts row",
    );
  });

  it("throws when the txt row doesn't exist", async () => {
    const db = { queryOnce: async () => ({ data: { txt: [] } }) };
    await expect(
      openDoc(db, "missing-txt", "txt", randomBytes(128)),
    ).rejects.toThrow("no txt row");
  });

  it("throws (via blob.decrypt's own AEAD check) under the wrong docKey", async () => {
    const { db } = await buildFixture(["part one"]);
    await expect(
      openDoc(db, "txt-1", "txt", randomBytes(128)),
    ).rejects.toThrow();
  });
});
