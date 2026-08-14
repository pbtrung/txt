import { Navigate, Route, BrowserRouter, Routes } from "react-router-dom";

import { LibraryScreen } from "./screens/Library/LibraryScreen";
import { ReaderScreen } from "./screens/Reader/ReaderScreen";
import { UnlockScreen } from "./screens/Unlock/UnlockScreen";

// No unlock-required route guard yet -- that needs real session state
// (VaultContext-equivalent), added once the data layer/Unlock screen exist.
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<UnlockScreen />} />
        <Route path="/library" element={<LibraryScreen />} />
        <Route path="/read/:txtId" element={<ReaderScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
