import type { AwsClient } from "aws4fetch";
import { describe, expect, it, vi } from "vitest";

import * as blob from "../crypto/blob";
import * as brotli from "../crypto/brotli";
import { fetchPart } from "./parts";
import * as r2 from "./r2";
import type { R2Config } from "./r2Config";

vi.mock("./r2", () => ({ getObject: vi.fn() }));

const config: R2Config = {
  endpoint: "https://example",
  region: "auto",
  bucket: "bucket",
  readOnlyAccessKeyId: "id",
  readOnlySecretAccessKey: "secret",
};

describe("fetchPart", () => {
  it("undoes ingest.py's exact pipeline: brotli-compress then Blob.encrypt (not Blob's own compressed flag)", async () => {
    const txtKey = new Uint8Array(64).fill(13);
    const text = "Cerryl learns that he has inherited his father's magic abilities.";

    const compressed = await brotli.compress(new TextEncoder().encode(text));
    const uploaded = await blob.encrypt(txtKey, compressed); // compressed left false, per ingest.py

    vi.mocked(r2.getObject).mockResolvedValue(uploaded);

    const result = await fetchPart({} as AwsClient, config, txtKey, "some-raw-path");
    expect(result).toBe(text);
  });
});
