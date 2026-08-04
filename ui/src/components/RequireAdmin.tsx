import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import { useVault } from "../state/VaultContext";

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session } = useVault();
  if (!session?.isAdmin) {
    return <Navigate to="/library" replace />;
  }
  return children;
}
