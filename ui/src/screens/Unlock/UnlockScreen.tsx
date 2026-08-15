// The only job here is loading the credential file: no headline, no
// explanatory copy -- a single button carrying both the action and its
// effect, matching the historical Unlock screen's UX. The file is this
// client's own reduced creds.json shape (ui/src/data/creds.ts).
import { useEffect, useRef, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
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
    event.target.value = "";
    if (file) {
      await unlock(file);
    }
  }

  const unlocking = status === "unlocking";

  return (
    <div className="container py-5 text-center" style={{ maxWidth: "24rem" }}>
      <h1 className="h3 mb-4">
        <i className="bi bi-book me-2" />
        Skypiea
      </h1>
      <button
        type="button"
        className="btn btn-primary w-100"
        onClick={() => inputRef.current?.click()}
        disabled={unlocking}
      >
        {unlocking && (
          <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
        )}
        {unlocking ? "Unlocking…" : "Choose File"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json"
        onChange={handleFileChange}
        hidden
      />
      {progress && (
        <p role="status" className="text-muted mt-3 mb-0">
          {progress.label} (step {progress.step} of {progress.total})
        </p>
      )}
      {error && (
        <p role="alert" className="alert alert-danger mt-3 mb-0">
          {error}
        </p>
      )}
    </div>
  );
}
