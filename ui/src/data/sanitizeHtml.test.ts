// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeHtml, stripHtmlToText } from "./sanitizeHtml";

describe("sanitizeHtml", () => {
  it("keeps ordinary formatting markup", () => {
    expect(sanitizeHtml("<p>A <b>desert</b> planet.</p>")).toBe(
      "<p>A <b>desert</b> planet.</p>",
    );
  });

  it("strips script tags", () => {
    expect(sanitizeHtml('<p>Hi</p><script>alert("x")</script>')).toBe("<p>Hi</p>");
  });

  it("strips event handler attributes", () => {
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).not.toContain("onerror");
  });

  it("strips javascript: URIs", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).not.toContain(
      "javascript:",
    );
  });
});

describe("stripHtmlToText", () => {
  it("returns plain text unchanged", () => {
    expect(stripHtmlToText("A desert planet.")).toBe("A desert planet.");
  });

  it("drops tags and keeps their text content", () => {
    expect(stripHtmlToText("<p>A <b>desert</b> planet.</p>")).toBe("A desert planet.");
  });
});
