import { describe, expect, it } from "vitest";

import * as brotli from "../crypto/brotli";
import { decodePart } from "./parts";

describe("decodePart", () => {
  it("brotli-decompresses stored content back into the original text", async () => {
    const text =
      "Cerryl learns that he has inherited his father's magic abilities.";
    const compressed = await brotli.compress(new TextEncoder().encode(text));

    const result = await decodePart(compressed);
    expect(result).toBe(text);
  });
});
