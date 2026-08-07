import { describe, expect, it } from "vitest";
import { preprocessText, splitParts } from "../txt/textproc.ts";

describe("preprocessText", () => {
  it("strips control/zero-width/BOM chars and collapses space runs", () => {
    const input = Buffer.from("Hello\u200bWorld\t\there now", "utf8");
    expect(preprocessText(input).toString("utf8")).toBe("HelloWorld here now");
  });

  it("puts every non-blank line on its own blank-separated entry", () => {
    const input = Buffer.from(
      "Hello\nWorld\n\nNext paragraph\n\n\n\nAnother   one\t here",
      "utf8",
    );
    expect(preprocessText(input).toString("utf8")).toBe(
      "Hello\n\nWorld\n\nNext paragraph\n\nAnother one here",
    );
  });

  it("drops leading blank lines and collapses trailing ones to one", () => {
    // Verified against the Python reference: leading blank lines vanish
    // entirely (nothing has been pushed to `out` yet to trigger a
    // separator), but a trailing run of blank lines still leaves exactly
    // one blank entry once real content already exists.
    const input = Buffer.from("\n\n  \nHello\n\n  \n", "utf8");
    expect(preprocessText(input).toString("utf8")).toBe("Hello\n");
  });

  it("replaces invalid UTF-8 byte sequences instead of throwing", () => {
    const input = Buffer.concat([
      Buffer.from("valid", "utf8"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("text", "utf8"),
    ]);
    expect(() => preprocessText(input)).not.toThrow();
  });
});

describe("splitParts", () => {
  it("keeps everything in one part when under target", () => {
    const content = Buffer.from("para one\n\npara two\n\npara three", "utf8");
    const parts = splitParts(content, 1024);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.toString("utf8")).toBe(
      "para one\n\npara two\n\npara three\n\n",
    );
  });

  it("splits on paragraph boundaries once target is exceeded, byte-exact", () => {
    const paras = [
      Buffer.alloc(100_000, 0x41),
      Buffer.alloc(100_000, 0x42),
      Buffer.alloc(100_000, 0x43),
      Buffer.alloc(5_000, 0x44),
    ];
    const content = Buffer.concat(
      paras.flatMap((p, i) => (i === 0 ? [p] : [Buffer.from("\n\n"), p])),
    );
    const parts = splitParts(content, 222 * 1024);
    expect(parts.map((p) => p.length)).toEqual([200_004, 105_004]);
    // Every paragraph gets its own trailing "\n\n" appended, so concatenating
    // every part reproduces the original content plus one final separator.
    const rejoined = Buffer.concat(parts);
    expect(rejoined.equals(Buffer.concat([content, Buffer.from("\n\n")]))).toBe(
      true,
    );
  });

  it("does not split a single paragraph larger than target", () => {
    const content = Buffer.alloc(500 * 1024, 0x41);
    const parts = splitParts(content, 222 * 1024);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.length).toBe(500 * 1024 + 2);
  });

  it("is byte-exact through multi-byte UTF-8 content", () => {
    const content = Buffer.from("café — 日本語\n\nsecond paragraph", "utf8");
    const parts = splitParts(content, 4);
    expect(parts.length).toBeGreaterThan(1);
    const rejoined = Buffer.concat(parts);
    expect(rejoined.equals(Buffer.concat([content, Buffer.from("\n\n")]))).toBe(
      true,
    );
  });
});
