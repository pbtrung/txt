import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { LibraryScreen } from "./screens/Library/LibraryScreen";
import { ReaderScreen } from "./screens/Reader/ReaderScreen";
import { UnlockScreen } from "./screens/Unlock/UnlockScreen";
import { useVault, VaultProvider } from "./state/VaultContext";

function RequireUnlocked() {
  const { status } = useVault();
  return status === "unlocked" ? <Outlet /> : <Navigate to="/" replace />;
}

export function App() {
  return (
    <AppErrorBoundary>
      <VaultProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<UnlockScreen />} />
            <Route element={<RequireUnlocked />}>
              <Route path="/library" element={<LibraryScreen />} />
              <Route path="/read/:txtId" element={<ReaderScreen />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </VaultProvider>
    </AppErrorBoundary>
  );
}
