import { Navigate, Route, BrowserRouter, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { LibraryScreen } from "./screens/Library/LibraryScreen";
import { ReaderScreen } from "./screens/Reader/ReaderScreen";
import { UnlockScreen } from "./screens/Unlock/UnlockScreen";
import { useVault, VaultProvider } from "./state/VaultContext";

function RequireUnlocked({ children }: { children: ReactNode }) {
  const { status } = useVault();
  return status === "unlocked" ? <>{children}</> : <Navigate to="/" replace />;
}

export function App() {
  return (
    <VaultProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<UnlockScreen />} />
          <Route
            path="/library"
            element={
              <RequireUnlocked>
                <LibraryScreen />
              </RequireUnlocked>
            }
          />
          <Route
            path="/read/:txtId"
            element={
              <RequireUnlocked>
                <ReaderScreen />
              </RequireUnlocked>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </VaultProvider>
  );
}
