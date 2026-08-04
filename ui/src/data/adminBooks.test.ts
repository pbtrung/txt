import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@instantdb/react", () => ({
  tx: {
    txtMetadata: new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === "string"
            ? {
                update: (payload: unknown) => ({
                  namespace: "txtMetadata",
                  id: prop,
                  payload,
                }),
              }
            : undefined,
      },
    ),
  },
}));

import * as blob from "../crypto/blob";
import { bytesToBase64, randomBytes } from "../crypto/bytes";
import {
  AdminBooksError,
  applyBookMetadataEdits,
  saveBookMetadata,
  type AdminBooksSession,
  type BookMetadataEdits,
} from "./adminBooks";
import { parseMetadataContent, type TxtMetadataContent } from "./metadata";

const docKey = randomBytes(128);
const session: AdminBooksSession = {
  docKeys: new Map([["txt-1", docKey]]),
};

function fakeDb(metadataRow: { id: string; content: string } | null) {
  return {
    queryOnce: vi.fn(async () => ({
      data: {
        txt: metadataRow
          ? [{ id: "txt-1", txtMetadata: [metadataRow] }]
          : [{ id: "txt-1", txtMetadata: [] }],
      },
    })),
    transact: vi.fn().mockResolvedValue(undefined),
  };
}

async function encodedMetadata(content: TxtMetadataContent): Promise<string> {
  const encrypted = await blob.encrypt(
    docKey,
    new TextEncoder().encode(JSON.stringify(content)),
    { compressed: true },
  );
  return bytesToBase64(encrypted);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyBookMetadataEdits", () => {
  it("updates curated fields while preserving unrelated metadata", () => {
    const next = applyBookMetadataEdits(
      {
        name: "book.txt",
        metadata: {
          title: "Old",
          creator: { text: "Old Author", role: "aut" },
          identifier: "isbn-1",
        },
      },
      {
        title: "New",
        author: "New Author",
        publisher: "Press",
        subjects: ["Fantasy", "Classic"],
        description: "A book.",
      },
    );

    expect(next).toEqual({
      name: "book.txt",
      metadata: {
        title: "New",
        creator: { text: "New Author", role: "aut" },
        identifier: "isbn-1",
        publisher: "Press",
        subject: ["Fantasy", "Classic"],
        description: "A book.",
      },
    });
  });

  it("removes empty curated fields", () => {
    const next = applyBookMetadataEdits(
      {
        name: "book.txt",
        metadata: {
          title: "Old",
          creator: "Old Author",
          publisher: "Press",
          subject: ["Fantasy"],
          description: "A book.",
        },
      },
      {
        title: undefined,
        author: "",
        publisher: " ",
        subjects: [],
        description: undefined,
      },
    );

    expect(next).toEqual({ name: "book.txt", metadata: {} });
  });
});

describe("saveBookMetadata", () => {
  it("rewrites txtMetadata content and returns updated BookInfo", async () => {
    const db = fakeDb({
      id: "metadata-1",
      content: await encodedMetadata({
        name: "book.txt",
        metadata: {
          title: "Old",
          creator: "Old Author",
          identifier: "isbn-1",
        },
      }),
    });
    const edits: BookMetadataEdits = {
      title: "New Title",
      author: "New Author",
      publisher: "Press",
      subjects: ["Fantasy"],
      description: "Updated.",
    };
    const progress = vi.fn();

    const info = await saveBookMetadata(db, session, "txt-1", edits, progress);

    expect(info).toMatchObject({
      txtId: "txt-1",
      title: "New Title",
      author: "New Author",
      publisher: "Press",
      subjects: ["Fantasy"],
      description: "Updated.",
    });
    expect(progress).toHaveBeenCalledWith("Loading metadata");
    expect(progress).toHaveBeenCalledWith("Saving metadata");
    expect(db.transact).toHaveBeenCalledOnce();
    const chunk = db.transact.mock.calls[0]![0][0] as {
      id: string;
      payload: { content: string };
    };
    expect(chunk.id).toBe("metadata-1");
    await expect(
      parseMetadataContent(docKey, chunk.payload.content),
    ).resolves.toEqual({
      name: "book.txt",
      metadata: {
        title: "New Title",
        creator: "New Author",
        identifier: "isbn-1",
        publisher: "Press",
        subject: "Fantasy",
        description: "Updated.",
      },
    });
  });

  it("rejects when the session has no document key for the book", async () => {
    const db = fakeDb(null);

    await expect(
      saveBookMetadata(db, { docKeys: new Map() }, "txt-1", {
        title: "New",
        subjects: [],
      }),
    ).rejects.toThrow(AdminBooksError);
    expect(db.queryOnce).not.toHaveBeenCalled();
    expect(db.transact).not.toHaveBeenCalled();
  });

  it("rejects when the txtMetadata row is missing", async () => {
    const db = fakeDb(null);

    await expect(
      saveBookMetadata(db, session, "txt-1", {
        title: "New",
        subjects: [],
      }),
    ).rejects.toThrow(AdminBooksError);
    expect(db.transact).not.toHaveBeenCalled();
  });
});
