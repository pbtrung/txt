// Screen 1 -- Unlock (docs/ui.md): the only job here is loading the
// credential file. No headline, no explanatory copy, no dropzone preview --
// a wordmark and a single button carrying both the action and its effect.

import { useEffect, useRef, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";

import { Wordmark } from "../../components/Wordmark";
import { useVault } from "../../state/VaultContext";

export function UnlockScreen() {
  const { status, error, unlock } = useVault();
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

        <button
          type="button"
          className="btn btn-primary btn-lg d-flex align-items-center gap-3 px-4 py-3 mx-auto"
          onClick={() => inputRef.current?.click()}
          disabled={unlocking}
        >
          <i className="bi bi-file-earmark fs-2" aria-hidden="true" />
          <span className="text-start lh-sm">
            <span className="d-block fw-semibold">{unlocking ? "Unlocking…" : "Choose File"}</span>
            <span className="d-block small fw-normal">to unlock your library</span>
          </span>
        </button>

        {unlocking && (
          <div className="mt-4 d-flex flex-column align-items-center gap-2">
            <div className="spinner-border spinner-border-sm text-primary" role="status" />
            <div className="small text-body-secondary">Setting up your library…</div>
          </div>
        )}

        {error && (
          <div className="alert alert-danger mt-4" role="alert">
            {error}
          </div>
        )}

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
