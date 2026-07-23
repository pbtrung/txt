// Mounts the real app from bytes verify.ts already fetched and SHA-512-
// checked -- never fetches index.html/the entry JS/CSS again (verifying
// once and then loading a second, unverified copy would reopen exactly the
// gap this whole feature exists to close). dist/index.html itself is only
// ever loaded/executed here to read off which two already-verified paths are
// the entry point (its own <script type=module>/<link rel=stylesheet>
// tags) -- it is never injected as markup or otherwise executed by
// local_index.html. Direct-CDN visits load dist/index.html the normal way;
// that's a separate path this file has no part in.

import { verbose } from "../log";

export class RenderError extends Error {}

function normalizeAssetPath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx + 1);
}

interface EntryPaths {
  jsPath: string;
  cssPath: string | null;
}

function extractEntryPaths(indexHtmlText: string): EntryPaths {
  const doc = new DOMParser().parseFromString(indexHtmlText, "text/html");
  const script = doc.querySelector('script[type="module"][src]');
  if (!script) {
    throw new RenderError('index.html has no <script type="module" src=...> to load');
  }
  const jsPath = normalizeAssetPath(script.getAttribute("src")!);
  const link = doc.querySelector('link[rel="stylesheet"][href]');
  const cssPath = link ? normalizeAssetPath(link.getAttribute("href")!) : null;
  return { jsPath, cssPath };
}

// leancrypto.js is deliberately excluded: it's an Emscripten UMD bundle that
// locates its own leancrypto.wasm relative to the <script src=...> tag
// crypto/leancryptoLoader.ts creates for it, not via an ES module import --
// inlining/blob-mapping it here wouldn't change how (or whether) it can find
// that wasm file, so it's simplest left on its existing live-fetch path.
function isEmbeddableChunkPath(path: string, jsPath: string): boolean {
  return path.endsWith(".js") && path !== jsPath && path !== "leancrypto.js";
}

/** Every other verified .js file (e.g. the chunk crypto/brotli.ts's dynamic
 * `import("brotli-wasm")` pulls in) gets remapped, via an import map, from
 * its real dist/ URL to a blob: URL built from bytes already verified in
 * verify.ts -- otherwise the running app would silently re-fetch it live
 * over the network, unverified against the manifest a second time, right
 * after we just went to the trouble of checking it once. An import map
 * entry must be present before the module graph that references it starts
 * loading, so this runs before the entry <script type=module> below is ever
 * appended. */
function installChunkImportMap(assetBaseUrl: string, jsPath: string, verified: Map<string, Uint8Array>): void {
  const root = `${assetBaseUrl.replace(/\/+$/, "")}/`;
  const imports: Record<string, string> = {};
  for (const [path, bytes] of verified) {
    if (!isEmbeddableChunkPath(path, jsPath)) continue;
    // Keyed by the chunk's real absolute dist/ URL -- the same one a live
    // dynamic import() of it would resolve to (relative specifiers inside
    // the entry module resolve against <base>, which render() below points
    // at this same assetBaseUrl root's entry-JS directory), so the browser's
    // own module resolution transparently swaps in the verified blob instead.
    const url = new URL(path, root).href;
    // new Uint8Array(bytes), not `bytes` directly: `verified`'s values are
    // typed as Uint8Array<ArrayBufferLike>, and BlobPart only accepts a view
    // backed by a real ArrayBuffer (not a SharedArrayBuffer) -- copying into
    // a fresh Uint8Array always allocates a plain ArrayBuffer.
    imports[url] = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "text/javascript" }));
    verbose(`localIndex: mapped ${path} to a verified blob: URL`);
  }
  if (Object.keys(imports).length === 0) return;
  const script = document.createElement("script");
  script.type = "importmap";
  script.textContent = JSON.stringify({ imports });
  document.head.appendChild(script);
}

/** Mounts the real app into the document from verified bytes. `verified` is
 * exactly what verify.ts's verifyAssets() returned -- every path keyed the
 * same way manifest.json (and so dist/'s own directory layout) keys it. */
export function renderApp(assetBaseUrl: string, verified: Map<string, Uint8Array>): void {
  const indexHtmlBytes = verified.get("index.html");
  if (!indexHtmlBytes) {
    throw new RenderError("manifest.json didn't include index.html");
  }
  const { jsPath, cssPath } = extractEntryPaths(new TextDecoder().decode(indexHtmlBytes));
  verbose(`localIndex: entry paths -- js=${jsPath}, css=${cssPath ?? "(none)"}`);

  const jsBytes = verified.get(jsPath);
  if (!jsBytes) {
    throw new RenderError(`index.html references ${jsPath}, which manifest.json didn't include`);
  }

  // Root-absolute references the app makes at runtime (CSS url(), the
  // dynamically-created <script src="/leancrypto.js"> in
  // crypto/leancryptoLoader.ts) resolve against this base's *origin* only,
  // ignoring its path -- but the entry JS's own relative
  // `import("./index.web-....js")` (for an inlined script with no `src`
  // attribute) resolves against the base URL's full path. Pointing <base>
  // at the entry JS's own directory, not assetBaseUrl's root, satisfies
  // both at once: confirmed against a real `vite build` output, where the
  // dynamic import is relative but every other reference is root-absolute.
  document.querySelectorAll("base").forEach((el) => el.remove());
  const base = document.createElement("base");
  base.href = `${assetBaseUrl.replace(/\/+$/, "")}/${dirOf(jsPath)}`;
  document.head.prepend(base);
  verbose(`localIndex: base href set to ${base.href}`);

  // Before the entry module ever runs (and so before it can trigger that
  // `import("./index.web-....js")`) -- an import map has to be in place
  // before the module graph referencing it starts loading.
  installChunkImportMap(assetBaseUrl, jsPath, verified);

  if (cssPath) {
    const cssBytes = verified.get(cssPath);
    if (cssBytes) {
      const style = document.createElement("style");
      style.textContent = new TextDecoder().decode(cssBytes);
      document.head.appendChild(style);
    }
  }

  const script = document.createElement("script");
  script.type = "module";
  script.textContent = new TextDecoder().decode(jsBytes);
  document.body.appendChild(script);
  verbose("localIndex: mounted app from verified bytes");
}
