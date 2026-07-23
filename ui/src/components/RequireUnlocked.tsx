// Guards routes that need an unlocked session. The session lives only in
// memory (VaultContext), so a reload -- or direct navigation without ever
// unlocking -- always bounces back to the Unlock screen.

import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";

import { useVault } from "../state/VaultContext";

export function RequireUnlocked({ children }: { children: ReactNode }) {
  const { status } = useVault();
  if (status !== "unlocked") {
    return <Navigate to="/" replace />;
  }
  return children;
}
