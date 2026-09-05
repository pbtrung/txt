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
// appears once a session is already known to work. A missing session
// redirects on its own after a short countdown rather than waiting on a
// click -- there's nothing else useful to do on this screen without one.
import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { Button, FileTrigger } from "react-aria-components";
import { useNavigate } from "react-router-dom";
import { useVault } from "../../state/VaultContext";

const REDIRECT_COUNTDOWN_SECONDS = 3;

// A fresh instance every time the "access-required" branch below starts
// rendering (React mounts it anew whenever the parent switches back to
// this branch) -- its own useState(3) initializer is the countdown reset,
// so the countdown effect only ever calls setCountdown from inside the
// interval's own callback, never synchronously in the effect body.
function AccessRedirectCountdown() {
  const [countdown, setCountdown] = useState(REDIRECT_COUNTDOWN_SECONDS);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown((remaining) => {
        if (remaining <= 1) {
          clearInterval(interval);
          window.location.assign("/v1/access-check");
          return 0;
        }
        return remaining - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <p role="status" className="mb-0 text-base-content/60">
      No Cloudflare Access session found. Redirecting to log in in {countdown}…
    </p>
  );
}

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
        <AccessRedirectCountdown />
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
