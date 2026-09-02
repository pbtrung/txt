// The only job here is loading the credential file: no headline, no
// explanatory copy -- a single button carrying both the action and its
// effect, matching the historical Unlock screen's UX. The file is this
// client's own reduced creds.json shape (ui/src/data/creds.ts).
import { useEffect } from "react";
import { BookOpen } from "lucide-react";
import { Button, FileTrigger } from "react-aria-components";
import { useNavigate } from "react-router-dom";
import { useVault } from "../../state/VaultContext";

export function UnlockScreen() {
  const { status, error, progress, unlock } = useVault();
  const navigate = useNavigate();

  useEffect(() => {
    if (status === "unlocked") {
      navigate("/library", { replace: true });
    }
  }, [status, navigate]);

  async function handleFileSelect(files: FileList | null) {
    const file = files?.[0];
    if (file) await unlock(file);
  }

  const unlocking = status === "unlocking";

  return (
    <div className="mx-auto w-full px-4 py-12 text-center unlock-panel">
      <h1 className="mb-6 flex items-center justify-center gap-2 text-3xl font-semibold">
        <BookOpen className="size-7" aria-hidden="true" />
        Skypiea
      </h1>
      <FileTrigger
        acceptedFileTypes={["application/json"]}
        onSelect={(files) => void handleFileSelect(files)}
      >
        <Button className="btn btn-primary px-6" isDisabled={unlocking}>
          {unlocking && (
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          )}
          {unlocking ? "Unlocking…" : "Choose File"}
        </Button>
      </FileTrigger>
      {progress && (
        <p role="status" className="mt-3 mb-0 text-base-content/60">
          {progress.label} (step {progress.step} of {progress.total})
        </p>
      )}
      {status === "access-required" && (
        <div role="alert" className="alert alert-warning mt-3 mb-0 block text-left">
          <p className="mb-2">
            You need a Cloudflare Access session before unlocking. Log in below, then
            choose your unlock file again.
          </p>
          <Button
            className="btn btn-sm"
            onPress={() => window.open("/v1/owner", "_blank", "noopener")}
          >
            Log in with Cloudflare Access
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="alert alert-error mt-3 mb-0">
          {error}
        </p>
      )}
    </div>
  );
}
