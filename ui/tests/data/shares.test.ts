import { describe, expect, it, vi } from "vitest";
import { encrypt, encryptJson } from "../../src/crypto/cryptoBlob";
import type { ApiClient, ShareRow } from "../../src/data/apiClient";
import type { LibraryBook } from "../../src/data/libraryStore";
import { loadShares } from "../../src/data/shares";
import { toBase64 } from "../../src/util/base64";

const UMK = crypto.getRandomValues(new Uint8Array(128));

function book(txtId: number, title: string): LibraryBook {
  return {
    txtId,
    title,
    authors: [],
    subjects: [],
    publisher: null,
    lastAccessed: 0,
    bookmarkCount: 0,
    lastBookmarked: null,
    latestBookmarkCfi: null,
    bookmarks: [],
  };
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function shareRow(documentId: number): Promise<ShareRow> {
  const rowKey = crypto.getRandomValues(new Uint8Array(128));
  const shareId = crypto.getRandomValues(new Uint8Array(32));
  const shareContentKey = crypto.getRandomValues(new Uint8Array(128));
  return {
    shareIdHash: crypto.getRandomValues(new Uint8Array(32)),
    documentId,
    keyWrapped: await encrypt(rowKey, UMK),
    ownerBlob: await encryptJson(
      {
        share_id: base64Url(shareId),
        share_content_key: toBase64(shareContentKey),
        share_path: "s".repeat(52),
      },
      rowKey,
    ),
    state: "active",
    createdAt: 1000,
  };
}

describe("loadShares", () => {
  it("decrypts each owner_blob and joins the title from the current book list", async () => {
    const row = await shareRow(5);
    const api = {
      fetchShares: vi.fn().mockResolvedValue([row]),
    } as unknown as ApiClient;

    const shares = await loadShares({ api }, [book(5, "Dune")], UMK);

    expect(shares).toHaveLength(1);
    expect(shares[0].txtId).toBe(5);
    expect(shares[0].title).toBe("Dune");
    expect(shares[0].sharePath).toBe("s".repeat(52));
    expect(shares[0].shareId.byteLength).toBe(32);
    expect(shares[0].contentKey.byteLength).toBe(128);
    expect(shares[0].state).toBe("active");
  });

  it("falls back to a generic title when the document isn't in the current book list", async () => {
    const row = await shareRow(9);
    const api = {
      fetchShares: vi.fn().mockResolvedValue([row]),
    } as unknown as ApiClient;

    const shares = await loadShares({ api }, [], UMK);

    expect(shares[0].title).toBe("Book");
  });
});
