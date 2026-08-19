import { RouterProvider as AriaRouterProvider } from "react-aria-components";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { LibraryScreen } from "./screens/Library/LibraryScreen";
import { ReaderScreen } from "./screens/Reader/ReaderScreen";
import { UnlockScreen } from "./screens/Unlock/UnlockScreen";
import { useVault, VaultProvider } from "./state/VaultContext";

function RequireUnlocked() {
  const { status } = useVault();
  return status === "unlocked" ? <Outlet /> : <Navigate to="/" replace />;
}

function AppRoutes() {
  const navigate = useNavigate();
  return (
    <AriaRouterProvider navigate={navigate}>
      <Routes>
        <Route path="/" element={<UnlockScreen />} />
        <Route element={<RequireUnlocked />}>
          <Route path="/library" element={<LibraryScreen />} />
          <Route path="/read/:txtId" element={<ReaderScreen />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AriaRouterProvider>
  );
}

export function App() {
  return (
    <AppErrorBoundary>
      <VaultProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </VaultProvider>
    </AppErrorBoundary>
  );
}
