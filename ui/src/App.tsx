import { Navigate, Route, Routes } from "react-router-dom";

import { pickRouterComponent } from "./appRouter";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RequireAdmin } from "./components/RequireAdmin";
import { RequireUnlocked } from "./components/RequireUnlocked";
import { LibraryScreen } from "./screens/Library/LibraryScreen";
import { ManageScreen } from "./screens/Manage/ManageScreen";
import { ReaderScreen } from "./screens/Reader/ReaderScreen";
import { UnlockScreen } from "./screens/Unlock/UnlockScreen";
import { VaultProvider } from "./state/VaultContext";

const Router = pickRouterComponent();

function App() {
  return (
    <ErrorBoundary>
      <VaultProvider>
        <Router>
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
            <Route
              path="/manage"
              element={
                <RequireUnlocked>
                  <RequireAdmin>
                    <ManageScreen />
                  </RequireAdmin>
                </RequireUnlocked>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </VaultProvider>
    </ErrorBoundary>
  );
}

export default App;
