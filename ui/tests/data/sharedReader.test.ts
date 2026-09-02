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
const GRANT = base64Url(new Uint8Array(96).fill(3));
const OBJECT_URL = "https://bucket.r2.cloudflarestorage.com/shared-object?sig=1";
const FRAGMENT = `#id=${ID}&key=${KEY}&grant=${GRANT}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("shared reader references", () => {
  it("accepts exact capability and content-key lengths", () => {
    expect(parseSharedReference(FRAGMENT)).toEqual({
      id: ID,
      contentKey: new Uint8Array(128).fill(2),
      grant: GRANT,
    });
  });

  it("rejects missing, malformed, or incorrectly sized values", () => {
    expect(parseSharedReference("")).toBeNull();
    expect(parseSharedReference(`#id=${ID}&key=not+url&grant=${GRANT}`)).toBeNull();
    expect(
      parseSharedReference(
        `#id=${base64Url(new Uint8Array(31))}&key=${KEY}&grant=${GRANT}`,
      ),
    ).toBeNull();
    expect(parseSharedReference(`#id=${ID}&key=${KEY}`)).toBeNull();
    expect(parseSharedReference(`#id=${ID}&key=${KEY}&grant=not+url`)).toBeNull();
  });
});

describe("loadSharedReaderDocument", () => {
  it("fetches the encrypted object without auth and decrypts metadata locally", async () => {
    const encrypted = new Uint8Array([4, 5]);
    const epub = new Uint8Array([6, 7]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sharedUrlResponse())
      .mockResolvedValueOnce(new Response(encrypted));
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
    const reference = parseSharedReference(FRAGMENT)!;
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
      "/v1/shared-url",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_id: ID, grant: GRANT }),
      }),
    );
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
    expect(fetchMock.mock.calls[1][0]).toBe(OBJECT_URL);
    expect(decrypt).toHaveBeenCalledWith(encrypted, new Uint8Array(128).fill(2));
    expect(progress.mock.calls.map(([value]) => value.step)).toEqual([1, 2, 3, 4]);
  });

  it("reports a deleted share without attempting decryption", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
    );
    const reference = parseSharedReference(FRAGMENT)!;

    await expect(loadSharedReaderDocument(reference)).rejects.toThrow(
      "This shared book is unavailable.",
    );
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("retries when the encrypted response body fails during transfer", async () => {
    vi.useFakeTimers();
    try {
      const first = new Response(new Uint8Array([1]));
      vi.spyOn(first, "arrayBuffer").mockRejectedValue(
        new TypeError("network load failed"),
      );
      const encrypted = new Uint8Array([4, 5]);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(sharedUrlResponse())
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(sharedUrlResponse())
        .mockResolvedValueOnce(new Response(encrypted));
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(decrypt).mockResolvedValue(new Uint8Array([6, 7]));
      vi.mocked(parseEpubOpf).mockResolvedValue({ metadata: { title: "Dune" } });
      vi.mocked(extraMetadataFields).mockReturnValue([]);
      const reference = parseSharedReference(FRAGMENT)!;

      const load = loadSharedReaderDocument(reference);
      const result = expect(load).resolves.toMatchObject({ title: "Dune" });
      await vi.runAllTimersAsync();

      await result;
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(decrypt).toHaveBeenCalledWith(encrypted, reference.contentKey);
    } finally {
      vi.useRealTimers();
    }
  });
});

function sharedUrlResponse(): Response {
  return new Response(JSON.stringify({ url: OBJECT_URL }), {
    headers: { "Content-Type": "application/json" },
  });
}

function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
