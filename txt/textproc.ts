// Cleaning and splitting raw .txt content into upload-sized parts (see
// docs/data_model.md's txtParts and docs/protocols.md's Ingest/write path).
// Port of the pre-InstantDB Python design's txt/textproc.py, kept
// byte-for-byte faithful to its two-stage split: splitParts first divides
// the *raw*, uncleaned file bytes into paragraph-bounded, target-sized
// chunks; preprocessText then cleans each chunk independently (txt/
// ingest.ts calls them in that order, one chunk at a time). One noted
// deviation from the Python original: Python's str.splitlines() also splits
// on a handful of additional Unicode line-boundary characters, not just
// \r\n/\r/\n -- this port only recognizes the latter. In practice this
// rarely matters, since most of those characters are already stripped by
// INVALID_CHARS_RE below before they'd ever act as a line boundary.
import * as C from "./constants.ts";

// Control chars, the U+FFFD decode-error marker, BOM, and invisible
// zero-width / bidi-formatting chars that are not human-readable text.
const INVALID_CHARS_RE =
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufffd\ufeff\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;
// Tabs, NBSP, and other Unicode space variants; collapsed to one space.
const SPACE_RUN_RE = /[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+/g;

function cleanLine(line: string): string {
  return line.replace(INVALID_CHARS_RE, "").replace(SPACE_RUN_RE, " ").trim();
}

// Every non-blank line becomes its own blank-line-separated entry in the
// output (this is the Python reference's actual behavior, verified against
// a real run of it, not just a reading of the source) -- consecutive blank
// source lines collapse to at most one separator, and leading/trailing
// blank lines are dropped.
export function preprocessText(content: Buffer): Buffer {
  const lines = content.toString("utf8").split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (line) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(line);
    } else if (out.length > 0 && out[out.length - 1] !== "") {
      out.push("");
    }
  }
  return Buffer.from(out.join("\n"), "utf8");
}

// Splits on paragraph breaks (a blank line) and accumulates paragraphs into
// target-sized chunks, byte-exact like the Python original (which operates
// on raw bytes, before UTF-8 decoding). Implemented via a latin1 round trip
// -- a lossless 1:1 byte<->code-unit mapping -- so a plain JS string regex
// can find the ASCII \r/\n boundaries without misinterpreting multi-byte
// UTF-8 sequences, since 0x0d/0x0a never appear as UTF-8 continuation
// bytes. A single paragraph larger than target is not split further and
// becomes an oversized part on its own, matching the Python original.
export function splitParts(
  content: Buffer,
  target: number = C.PART_TARGET,
): Buffer[] {
  const paras = content.toString("latin1").split(/\r?\n\r?\n/);
  const parts: Buffer[] = [];
  let cur = "";
  for (const p of paras) {
    const chunk = p + "\n\n";
    if (cur && cur.length + chunk.length > target) {
      parts.push(Buffer.from(cur, "latin1"));
      cur = chunk;
    } else {
      cur += chunk;
    }
  }
  if (cur) parts.push(Buffer.from(cur, "latin1"));
  return parts;
}
