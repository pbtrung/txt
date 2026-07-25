// Guards the Manage screen (/manage). Mirrors RequireUnlocked.tsx exactly,
// checking session.isAdmin instead of the unlock status -- a non-admin
// session bounces back to /library rather than seeing a screen with nothing
// it's allowed to do (the real enforcement is Turso's own token grants,
// this is just keeping a regular user from landing on a confusing screen).

import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";

import { useVault } from "../state/VaultContext";

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session } = useVault();
  if (!session?.isAdmin) {
    return <Navigate to="/library" replace />;
  }
  return children;
}
