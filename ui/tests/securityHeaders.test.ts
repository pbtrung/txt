import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const headers = readFileSync(new URL("../_headers", import.meta.url), "utf8");
const policy = headers
  .split("\n")
  .find((line) => line.trimStart().startsWith("Content-Security-Policy:"));

describe("static security headers", () => {
  it("blocks external resources from inherited EPUB frame policies", () => {
    expect(policy).toBeDefined();
    for (const directive of [
      "style-src",
      "img-src",
      "font-src",
      "media-src",
      "frame-src",
    ]) {
      expect(policy).toMatch(
        new RegExp(`${directive} 'self'(?: 'unsafe-inline')? blob: data:;`),
      );
    }
    expect(policy).toContain("object-src 'none'");
  });
});
