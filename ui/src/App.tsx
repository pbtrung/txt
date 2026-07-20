import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { RequireUnlocked } from "./components/RequireUnlocked";
import { LibraryScreen } from "./screens/Library/LibraryScreen";
import { ReaderScreen } from "./screens/Reader/ReaderScreen";
import { UnlockScreen } from "./screens/Unlock/UnlockScreen";
import { VaultProvider } from "./state/VaultContext";

function App() {
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

export default App;
