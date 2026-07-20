// Placeholder -- Screen 2 (Library) is built out in full in a later step
// (docs/ui.md). This just proves the unlock -> routing -> session wiring
// works end to end.

import { useVault } from "../../state/VaultContext";

export function LibraryScreen() {
  const { session, lock } = useVault();

  return (
    <div className="container py-4">
      <p>Unlocked as {session?.creds.displayName}.</p>
      <button type="button" className="btn btn-outline-secondary" onClick={lock}>
        Lock
      </button>
    </div>
  );
}
