// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RenderError, renderApp } from "./render";

const ASSET_BASE_URL = "https://cdn.example.com/app";
const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" crossorigin href="/assets/index-Dhzd6RBh.css">
    <script type="module" crossorigin src="/assets/index-BrwasotO.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

function verifiedMap(overrides: Record<string, string> = {}): Map<string, Uint8Array> {
  const files: Record<string, string> = {
    "index.html": INDEX_HTML,
    "assets/index-BrwasotO.js": "console.log('app')",
    "assets/index-Dhzd6RBh.css": "body { color: red; }",
    ...overrides,
  };
  const map = new Map<string, Uint8Array>();
  for (const [path, text] of Object.entries(files)) {
    map.set(path, new TextEncoder().encode(text));
  }
  return map;
}

beforeEach(() => {
  // verbose logging defaults to on (see src/log.ts) -- silence it rather
  // than let it clutter every test run's output.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll("base").forEach((el) => el.remove());
  document.querySelectorAll("style").forEach((el) => el.remove());
  document.querySelectorAll("script").forEach((el) => el.remove());
  delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
});

// jsdom doesn't implement URL.createObjectURL -- stub it so tests can assert
// on the blob: URLs installChunkImportMap() creates without needing a real
// Blob/URL registry.
function stubCreateObjectURL(): ReturnType<typeof vi.fn> {
  const stub = vi.fn((blob: Blob) => `blob:mock/${blob.size}`);
  (URL as unknown as { createObjectURL: typeof stub }).createObjectURL = stub;
  return stub;
}

describe("renderApp", () => {
  it("sets <base> to the entry JS's own directory under assetBaseUrl", () => {
    renderApp(ASSET_BASE_URL, verifiedMap());
    const base = document.querySelector("base")!;
    expect(base.getAttribute("href")).toBe("https://cdn.example.com/app/assets/");
  });

  it("inlines the verified CSS into a <style> in <head>", () => {
    renderApp(ASSET_BASE_URL, verifiedMap());
    const style = document.head.querySelector("style")!;
    expect(style.textContent).toBe("body { color: red; }");
  });

  it("inlines the verified JS into a <script type=module> in <body>", () => {
    renderApp(ASSET_BASE_URL, verifiedMap());
    const script = document.body.querySelector("script")!;
    expect(script.type).toBe("module");
    expect(script.textContent).toBe("console.log('app')");
  });

  it("removes any pre-existing <base> before adding its own", () => {
    const stale = document.createElement("base");
    stale.href = "https://stale.example.com/";
    document.head.appendChild(stale);

    renderApp(ASSET_BASE_URL, verifiedMap());

    expect(document.querySelectorAll("base")).toHaveLength(1);
    expect(document.querySelector("base")!.getAttribute("href")).not.toContain("stale");
  });

  it("skips the <style> when index.html has no stylesheet link", () => {
    const noCss = INDEX_HTML.replace(/<link[^>]*>\n\s*/, "");
    const verified = verifiedMap({ "index.html": noCss });

    expect(() => renderApp(ASSET_BASE_URL, verified)).not.toThrow();
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("throws when manifest didn't include index.html", () => {
    const verified = verifiedMap();
    verified.delete("index.html");
    expect(() => renderApp(ASSET_BASE_URL, verified)).toThrow(RenderError);
    expect(() => renderApp(ASSET_BASE_URL, verified)).toThrow(/didn't include index\.html/);
  });

  it("throws when index.html has no <script type=module src=...>", () => {
    const verified = verifiedMap({ "index.html": "<!doctype html><body></body>" });
    expect(() => renderApp(ASSET_BASE_URL, verified)).toThrow(RenderError);
    expect(() => renderApp(ASSET_BASE_URL, verified)).toThrow(/no <script/);
  });

  it("throws when index.html's entry script path isn't in the verified set", () => {
    const verified = verifiedMap();
    verified.delete("assets/index-BrwasotO.js");
    expect(() => renderApp(ASSET_BASE_URL, verified)).toThrow(RenderError);
    expect(() => renderApp(ASSET_BASE_URL, verified)).toThrow(/didn't include/);
  });

  describe("dynamically-imported chunk embedding", () => {
    it("maps a verified extra .js chunk's real dist/ URL to a blob: URL via an import map", () => {
      const createObjectURL = stubCreateObjectURL();
      const verified = verifiedMap({ "assets/index.web-abc123.js": "console.log('chunk')" });

      renderApp(ASSET_BASE_URL, verified);

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blob = createObjectURL.mock.calls[0][0];
      expect(blob.type).toBe("text/javascript");

      const importMap = document.head.querySelector('script[type="importmap"]')!;
      const parsed = JSON.parse(importMap.textContent!);
      expect(parsed.imports).toEqual({
        "https://cdn.example.com/app/assets/index.web-abc123.js": createObjectURL.mock.results[0].value,
      });
    });

    it("does not remap the entry JS itself or leancrypto.js", () => {
      const createObjectURL = stubCreateObjectURL();
      const verified = verifiedMap({
        "leancrypto.js": "var leancrypto = {};",
        "assets/index.web-abc123.js": "console.log('chunk')",
      });

      renderApp(ASSET_BASE_URL, verified);

      expect(createObjectURL).toHaveBeenCalledTimes(1); // only the extra chunk, not the entry or leancrypto.js
      const importMap = document.head.querySelector('script[type="importmap"]')!;
      const parsed = JSON.parse(importMap.textContent!);
      expect(Object.keys(parsed.imports)).toEqual(["https://cdn.example.com/app/assets/index.web-abc123.js"]);
    });

    it("adds no import map at all when there's nothing extra to remap", () => {
      const createObjectURL = stubCreateObjectURL();
      renderApp(ASSET_BASE_URL, verifiedMap());
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(document.head.querySelector('script[type="importmap"]')).toBeNull();
    });

    it("installs the import map before the entry <script type=module>, not after", () => {
      stubCreateObjectURL();
      const verified = verifiedMap({ "assets/index.web-abc123.js": "console.log('chunk')" });

      renderApp(ASSET_BASE_URL, verified);

      const importMap = document.head.querySelector('script[type="importmap"]')!;
      const entryScript = document.body.querySelector('script[type="module"]')!;
      expect(importMap.compareDocumentPosition(entryScript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
