// The boot sequence local_index.html runs on open: verify everything
// (verify.ts) before ever mounting the real app from those verified bytes
// (render.ts), driving the spinner/progress list (progress.ts) throughout.
// See main.ts for the actual bundle entry point that wires this to the
// build-time-embedded public key/asset_base_url.

import { base64ToBytes } from "../crypto/bytes";
import { verbose } from "../log";
import { mountProgressUI } from "./progress";
import { renderApp } from "./render";
import { verifyAssets } from "./verify";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves once #root has actually been populated (renderApp's inlined
 * <script type="module"> executes asynchronously -- insertion into the DOM
 * doesn't mean it's run yet), so the progress overlay isn't removed a beat
 * before the real app is actually visible. */
function waitForRootMount(): Promise<void> {
  const root = document.getElementById("root");
  if (!root || root.childElementCount > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (root.childElementCount > 0) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(root, { childList: true });
  });
}

export async function boot(assetBaseUrl: string, publicKeyB64: string): Promise<void> {
  verbose(`localIndex: boot starting, assetBaseUrl=${assetBaseUrl}`);
  const ui = mountProgressUI();
  try {
    const publicKey = base64ToBytes(publicKeyB64);
    const verified = await verifyAssets(assetBaseUrl, publicKey, (step) => ui.advance(step));

    // Verification itself only ever needs fetch()/Web Crypto -- no Worker/
    // SharedArrayBuffer -- but a bare file:// origin can still make its
    // fetch() calls fail outright (verify.ts's fetchFailureError has the
    // detail: browsers can refuse a file://-origin cross-origin fetch even
    // against a server that sends Access-Control-Allow-Origin: *, since
    // file:// doesn't send a normal Origin header for that to match
    // against). When verification does succeed, though, the real app's lazy
    // VFS still needs a Worker + SharedArrayBuffer bridge (dbWorker.ts's own
    // header comment), which browsers only expose to a cross-origin-
    // isolated page -- a bare file://content:// document can never be that,
    // so rendering the app here would just fail later with a much more
    // confusing error than stopping now and saying so plainly: verification
    // already proved the CDN is trustworthy, that's exactly what this page
    // exists to do without needing the app itself to run.
    if (!crossOriginIsolated) {
      verbose("localIndex: verified OK, but not cross-origin isolated -- can't boot the app here");
      ui.showVerifiedFallback(assetBaseUrl);
      return;
    }

    ui.advance("loading-application");
    renderApp(assetBaseUrl, verified);
    await waitForRootMount();
    ui.remove();
    verbose("localIndex: boot done");
  } catch (err) {
    verbose("localIndex: boot failed", err);
    ui.fail(errorMessage(err));
  }
}
