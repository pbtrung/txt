// Screen 1 -- Unlock (docs/ui.md): the only job here is loading the
// credential file. No headline, no explanatory copy, no dropzone preview --
// a wordmark and a single button carrying both the action and its effect.

import { useEffect, useRef, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";

import { Wordmark } from "../../components/Wordmark";
import { useVault } from "../../state/VaultContext";

export function UnlockScreen() {
  const { status, error, progress, unlock } = useVault();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "unlocked") {
      navigate("/library", { replace: true });
    }
  }, [status, navigate]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file after an error
    if (file) {
      await unlock(file);
    }
  }

  const unlocking = status === "unlocking";

  return (
    <div className="d-flex align-items-center justify-content-center vh-100">
      <div className="text-center" style={{ maxWidth: "24rem" }}>
        <div className="mb-4">
          <Wordmark size="lg" />
        </div>

        {/* position-relative wraps just the button (not the status block
            below) so the error box, anchored to *this* wrapper's own
            bottom edge, sits directly under the button -- not under the
            status block's own reserved (but often invisible) height, which
            would otherwise leave a large dead gap above the error. */}
        <div className="position-relative">
          <button
            type="button"
            className="btn btn-primary d-flex align-items-center gap-2 px-3 py-2 mx-auto"
            onClick={() => inputRef.current?.click()}
            disabled={unlocking}
          >
            <i className="bi bi-file-earmark fs-5" aria-hidden="true" />
            <span className="text-start lh-sm">
              <span className="d-block fw-semibold small">
                {unlocking ? "Unlocking…" : "Choose File"}
              </span>
              <span className="d-block small fw-normal">to unlock your library</span>
            </span>
          </button>

          {error && (
            <div
              className="alert alert-danger mt-2 position-absolute start-0 end-0"
              style={{ top: "100%" }}
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        {/* role="status" on the wrapper, not the (otherwise unlabeled)
            spinner glyph itself -- it's a live region, so the two text
            lines below get re-announced as progress updates them, and the
            spinner stays purely decorative next to them. A non-breaking
            space holds the first line's height even before the first
            phase lands, so the block doesn't visibly grow by a line
            moments after appearing. Always rendered (not `unlocking &&`),
            just hidden via visibility rather than unmounted -- unmounting
            it would let the wordmark/button above shift when the outer
            box's own vertical centering recalculates around this block's
            height appearing/disappearing; reserving its space up front
            keeps them anchored in place regardless. */}
        <div
          className="mt-3 d-flex flex-column align-items-center gap-1"
          role="status"
          style={{ visibility: unlocking ? "visible" : "hidden" }}
        >
          <div className="spinner-border spinner-border-sm text-primary mb-1" aria-hidden="true" />
          <div className="small text-body-secondary">
            {progress ? `Step ${progress.step} of ${progress.total}` : " "}
          </div>
          <div className="small text-body-secondary">
            {progress?.label ?? "Setting up your library"}…
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="d-none"
          onChange={handleFileChange}
          aria-label="Choose config file"
        />
      </div>
    </div>
  );
}
