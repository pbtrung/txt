import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/crypto/cryptoBlob", () => ({ decrypt: vi.fn() }));
vi.mock("../../src/data/epubOpf", () => ({
  parseEpubOpf: vi.fn(),
  extraMetadataFields: vi.fn(),
}));

import { decrypt } from "../../src/crypto/cryptoBlob";
import { extraMetadataFields, parseEpubOpf } from "../../src/data/epubOpf";
import {
  loadSharedReaderDocument,
  parseSharedReference,
} from "../../src/data/sharedReader";
import { toBase64 } from "../../src/util/base64";

const ID = base64Url(new Uint8Array(32).fill(1));
const KEY = base64Url(new Uint8Array(128).fill(2));
const GRANT = base64Url(new Uint8Array(64).fill(3));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("shared reader references", () => {
  it("accepts exact capability and content-key lengths", () => {
    expect(parseSharedReference(`#id=${ID}&grant=${GRANT}&key=${KEY}`)).toEqual({
      id: ID,
      grant: GRANT,
      contentKey: new Uint8Array(128).fill(2),
    });
  });

  it("rejects missing, malformed, or incorrectly sized values", () => {
    expect(parseSharedReference("")).toBeNull();
    expect(parseSharedReference(`#id=${ID}&grant=${GRANT}&key=not+url`)).toBeNull();
    expect(
      parseSharedReference(
        `#id=${base64Url(new Uint8Array(31))}&grant=${GRANT}&key=${KEY}`,
      ),
    ).toBeNull();
  });
});

describe("loadSharedReaderDocument", () => {
  it("fetches the encrypted object without auth and decrypts metadata locally", async () => {
    const encrypted = new Uint8Array([4, 5]);
    const epub = new Uint8Array([6, 7]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(encrypted));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(decrypt).mockResolvedValue(epub);
    vi.mocked(parseEpubOpf).mockResolvedValue({
      metadata: {
        title: "Dune",
        creator: "Frank Herbert",
        subject: ["Fiction", "Desert"],
        publisher: "Ace",
      },
    });
    vi.mocked(extraMetadataFields).mockReturnValue([]);
    const reference = parseSharedReference(`#id=${ID}&grant=${GRANT}&key=${KEY}`)!;
    const progress = vi.fn();

    await expect(loadSharedReaderDocument(reference, progress)).resolves.toEqual({
      txtId: 0,
      lastCfi: null,
      title: "Dune",
      authors: ["Frank Herbert"],
      subjects: ["Fiction", "Desert"],
      publisher: "Ace",
      extraMetadata: [],
      epubBytes: epub,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/shared-content",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_id: ID, grant: GRANT }),
      }),
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    expect(decrypt).toHaveBeenCalledWith(encrypted, new Uint8Array(128).fill(2));
    expect(progress.mock.calls.map(([value]) => value.step)).toEqual([1, 2, 3, 4]);
  });

  it("reports a deleted share without attempting decryption", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
    );
    const reference = parseSharedReference(`#id=${ID}&grant=${GRANT}&key=${KEY}`)!;

    await expect(loadSharedReaderDocument(reference)).rejects.toThrow(
      "This shared book is unavailable.",
    );
    expect(decrypt).not.toHaveBeenCalled();
  });
});

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
