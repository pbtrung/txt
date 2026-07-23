// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

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

afterEach(() => {
  document.querySelectorAll("base").forEach((el) => el.remove());
  document.querySelectorAll("style").forEach((el) => el.remove());
  document.querySelectorAll("script").forEach((el) => el.remove());
});

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
});
