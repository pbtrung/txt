// The only job here is loading the credential file: no headline, no
// explanatory copy -- a single button carrying both the action and its
// effect, matching the historical Unlock screen's UX. The file is this
// client's own reduced creds.json shape (ui/src/data/creds.ts).
//
// VaultContext probes for an existing Cloudflare Access session on mount,
// before this screen ever shows a file picker: choosing a file used to
// come first, so a missing session was only discovered afterward, and
// the file (never itself stored anywhere) was lost across the full-page
// navigation Access's own login redirect requires -- the owner had to
// pick it again once back. Probing first means "Choose File" only ever
// appears once a session is already known to work.
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
  const checkingAccess = status === "checking-access";

  return (
    <div className="mx-auto w-full px-4 py-12 text-center unlock-panel">
      <h1 className="mb-6 flex items-center justify-center gap-2 text-3xl font-semibold">
        <BookOpen className="size-7" aria-hidden="true" />
        Skypiea
      </h1>
      {checkingAccess ? (
        <p role="status" className="mb-0 text-base-content/60">
          <span
            className="loading loading-spinner loading-sm mr-2 align-middle"
            aria-hidden="true"
          />
          Checking Cloudflare Access session…
        </p>
      ) : status === "access-required" ? (
        <div role="alert" className="alert alert-warning mb-0 block text-left">
          <p className="mb-2">You need a Cloudflare Access session before unlocking.</p>
          <Button
            className="btn btn-sm"
            onPress={() => window.location.assign("/v1/access-check")}
          >
            Log in with Cloudflare Access
          </Button>
        </div>
      ) : (
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
      )}
      {progress && (
        <p role="status" className="mt-3 mb-0 text-base-content/60">
          {progress.label} (step {progress.step} of {progress.total})
        </p>
      )}
      {error && (
        <p role="alert" className="alert alert-error mt-3 mb-0">
          {error}
        </p>
      )}
    </div>
  );
}
