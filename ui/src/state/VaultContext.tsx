// Holds the unlocked session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen (docs/auth.md §5 step 6).
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AccessRequiredError, ApiClient } from "../data/apiClient";
import { parseBrowserCreds, type BrowserCreds } from "../data/creds";
import { LibraryStore } from "../data/libraryStore";
import { withNetworkRetries } from "../data/networkRequest";
import type { OwnerSigningIdentity } from "../data/ownerProof";
import { R2Session } from "../data/r2Session";
import { unwrapOwner } from "../data/session";
import { errorMessage } from "../util/errorMessage";

type VaultStatus = "locked" | "unlocking" | "access-required" | "unlocked";

interface VaultProgress {
  label: string;
  step: number;
  total: number;
}

const PHASES = [
  "Reading credentials",
  "Requesting owner record",
  "Unwrapping keys",
  "Requesting storage access",
  "Loading your library",
] as const;

export interface VaultSession {
  library: LibraryStore;
  storage: R2Session;
  api: ApiClient;
  signing: OwnerSigningIdentity;
  umk: Uint8Array;
  displayName: string;
  dbPrefix: string;
}

interface VaultContextValue {
  status: VaultStatus;
  session: VaultSession | null;
  error: string | null;
  progress: VaultProgress | null;
  unlock: (file: File) => Promise<void>;
  lock: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

class SessionResolver {
  constructor(
    private readonly file: File,
    private readonly onPhase: (index: number) => void,
  ) {}

  async resolve(): Promise<VaultSession> {
    const creds = await this.readCredentials();
    const api = new ApiClient();
    this.onPhase(1);
    const owner = await withNetworkRetries((signal) => api.fetchOwner(signal));
    this.onPhase(2);
    const unwrapped = await unwrapOwner(owner, creds.user_root_key);
    this.onPhase(3);
    const credentials = await withNetworkRetries((signal) =>
      api.fetchR2Credentials(unwrapped.signing, unwrapped.dbPrefix, signal),
    );
    const storage = new R2Session(
      api,
      unwrapped.signing,
      unwrapped.dbPrefix,
      credentials,
    );
    this.onPhase(4);
    const library = await LibraryStore.open(
      api,
      storage,
      unwrapped.signing,
      unwrapped.dbPrefix,
      unwrapped.umk,
    );
    return {
      library,
      storage,
      api,
      signing: unwrapped.signing,
      umk: unwrapped.umk,
      displayName: unwrapped.displayName,
      dbPrefix: unwrapped.dbPrefix,
    };
  }

  private async readCredentials(): Promise<BrowserCreds> {
    this.onPhase(0);
    return parseBrowserCreds(JSON.parse(await this.file.text()));
  }
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<VaultProgress | null>(null);

  // Guards against unlock()/lock() overlap: each call claims the next
  // generation, and an unlock() whose generation was superseded by a later
  // unlock()/lock() call before it resolved discards its result instead of
  // reviving a session the user already moved past.
  const generation = useRef(0);

  const unlock = useCallback(async (file: File) => {
    const myGeneration = ++generation.current;
    setStatus("unlocking");
    setError(null);
    try {
      const onPhase = (index: number) => {
        if (generation.current !== myGeneration) return;
        setProgress({ label: PHASES[index], step: index + 1, total: PHASES.length });
      };
      const resolved = await new SessionResolver(file, onPhase).resolve();
      if (generation.current !== myGeneration) return;
      setSession(resolved);
      setStatus("unlocked");
    } catch (err) {
      if (generation.current !== myGeneration) return;
      if (err instanceof AccessRequiredError) {
        setStatus("access-required");
      } else {
        setError(errorMessage(err));
        setStatus("locked");
      }
    } finally {
      if (generation.current === myGeneration) setProgress(null);
    }
  }, []);

  const lock = useCallback(() => {
    generation.current += 1;
    setSession(null);
    setStatus("locked");
    setError(null);
    setProgress(null);
  }, []);

  const value = useMemo(
    () => ({ status, session, error, progress, unlock, lock }),
    [status, session, error, progress, unlock, lock],
  );
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault() must be used within a VaultProvider");
  return ctx;
}
