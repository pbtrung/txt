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
