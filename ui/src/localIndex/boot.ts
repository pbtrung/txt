// The boot sequence local_index.html runs on open: verify everything
// (verify.ts) before ever mounting the real app from those verified bytes
// (render.ts), driving the spinner/progress list (progress.ts) throughout.
// See main.ts for the actual bundle entry point that wires this to the
// build-time-embedded public key/asset_base_url.

import { base64ToBytes } from "../crypto/bytes";
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
  const ui = mountProgressUI();
  try {
    const publicKey = base64ToBytes(publicKeyB64);
    const verified = await verifyAssets(assetBaseUrl, publicKey, (step) => ui.advance(step));
    ui.advance("loading-application");
    renderApp(assetBaseUrl, verified);
    await waitForRootMount();
    ui.remove();
  } catch (err) {
    ui.fail(errorMessage(err));
  }
}
