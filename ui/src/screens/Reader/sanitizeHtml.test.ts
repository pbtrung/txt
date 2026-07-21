// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { descriptionPlainText, sanitizeDescriptionHtml } from "./sanitizeHtml";

describe("sanitizeDescriptionHtml", () => {
  it("keeps allowed formatting tags", () => {
    const result = sanitizeDescriptionHtml(
      "<p>Cerryl learns that he has <b>inherited</b> his father's <i>magic</i>.</p>",
    );
    expect(result).toBe("<p>Cerryl learns that he has <b>inherited</b> his father's <i>magic</i>.</p>");
  });

  it("strips script tags and their content entirely", () => {
    const result = sanitizeDescriptionHtml('<p>Hello</p><script>alert("xss")</script>');
    expect(result).toBe("<p>Hello</p>");
    expect(result).not.toContain("script");
  });

  it("strips inline event handler attributes", () => {
    const result = sanitizeDescriptionHtml('<p onclick="alert(1)">Click me</p>');
    expect(result).not.toContain("onclick");
    expect(result).toContain("Click me");
  });

  it("strips javascript: URIs from links", () => {
    const result = sanitizeDescriptionHtml('<a href="javascript:alert(1)">link</a>');
    expect(result).not.toContain("javascript:");
  });

  it("keeps a safe href on a link", () => {
    const result = sanitizeDescriptionHtml('<a href="https://example.com">link</a>');
    expect(result).toContain('href="https://example.com"');
  });

  it("strips disallowed structural tags (e.g. iframe, img, style) but keeps their text", () => {
    const result = sanitizeDescriptionHtml(
      '<iframe src="https://evil.example"></iframe><style>body{}</style>Plain text',
    );
    expect(result).not.toContain("iframe");
    expect(result).not.toContain("style");
    expect(result).toContain("Plain text");
  });

  it("passes plain text (no markup) through unchanged", () => {
    expect(sanitizeDescriptionHtml("Just a plain description.")).toBe("Just a plain description.");
  });
});

describe("descriptionPlainText", () => {
  it("strips all markup, keeping only the text", () => {
    const result = descriptionPlainText("<p>Cerryl learns that he has <b>inherited</b> his father's magic.</p>");
    expect(result).toBe("Cerryl learns that he has inherited his father's magic.");
  });

  it("still strips a script tag's content, not just the tag", () => {
    const result = descriptionPlainText('<p>Hello</p><script>alert("xss")</script>');
    expect(result).toBe("Hello");
  });

  it("passes plain text through unchanged", () => {
    expect(descriptionPlainText("Just a plain description.")).toBe("Just a plain description.");
  });
});
