// Holds the unlocked session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen (docs/auth.md §5 step 6).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AccessRequiredError, ApiClient, type OwnerRecord } from "../data/apiClient";
import { parseBrowserCreds, type BrowserCreds } from "../data/creds";
import { LibraryStore } from "../data/libraryStore";
import { withNetworkRetries } from "../data/networkRequest";
import type { OwnerSigningIdentity } from "../data/ownerProof";
import { R2Session } from "../data/r2Session";
import { unwrapOwner } from "../data/session";
import { errorMessage } from "../util/errorMessage";

// "checking-access": the mount-time GET /v1/owner probe below hasn't
// resolved yet -- neither "Choose File" nor "Log in with Cloudflare
// Access" is shown until it has, so the owner record it fetches is
// already in hand by the time a file even could be chosen.
type VaultStatus =
  "checking-access" | "locked" | "unlocking" | "access-required" | "unlocked";

interface VaultProgress {
  label: string;
  step: number;
  total: number;
}

// Owner record fetching moved out of this list and into the mount-time
// probe above -- by the time any of these phases run, it's already been
// fetched once, not fetched again.
const PHASES = [
  "Reading credentials",
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
    private readonly owner: OwnerRecord,
    private readonly api: ApiClient,
    private readonly onPhase: (index: number) => void,
  ) {}

  async resolve(): Promise<VaultSession> {
    const creds = await this.readCredentials();
    this.onPhase(1);
    const unwrapped = await unwrapOwner(this.owner, creds.user_root_key);
    this.onPhase(2);
    const credentials = await withNetworkRetries((signal) =>
      this.api.fetchR2Credentials(unwrapped.signing, unwrapped.dbPrefix, signal),
    );
    const storage = new R2Session(
      this.api,
      unwrapped.signing,
      unwrapped.dbPrefix,
      credentials,
    );
    this.onPhase(3);
    const library = await LibraryStore.open(
      this.api,
      storage,
      unwrapped.signing,
      unwrapped.dbPrefix,
      unwrapped.umk,
    );
    return {
      library,
      storage,
      api: this.api,
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
  const [status, setStatus] = useState<VaultStatus>("checking-access");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<VaultProgress | null>(null);

  // One ApiClient for the whole page lifetime: the mount-time probe below
  // and a later unlock() share it, rather than each minting its own. A
  // lazy useState (not a ref) since a ref's .current can't be read during
  // render (react-hooks/refs).
  const [api] = useState(() => new ApiClient());
  // Set by the mount-time probe once GET /v1/owner succeeds; unlock()
  // reuses it instead of fetching the owner record a second time.
  const ownerRef = useRef<OwnerRecord | null>(null);

  // Guards against unlock()/lock() overlap, and against this mount-time
  // probe resolving after a lock() (or a second mount in React's Strict
  // Mode dev double-invoke) already moved past it: each call claims the
  // next generation, and one whose generation was superseded before it
  // resolved discards its result instead of reviving stale state.
  const generation = useRef(0);

  useEffect(() => {
    const myGeneration = ++generation.current;
    (async () => {
      try {
        const owner = await withNetworkRetries((signal) => api.fetchOwner(signal));
        if (generation.current !== myGeneration) return;
        ownerRef.current = owner;
        setStatus("locked");
      } catch (err) {
        if (generation.current !== myGeneration) return;
        if (err instanceof AccessRequiredError) {
          setStatus("access-required");
        } else {
          // Not an access problem -- e.g. a genuine server error. Fall
          // back to the normal locked state rather than stranding the
          // user on neither button; choosing a file will hit the same
          // failure again through unlock()'s own error handling.
          setError(errorMessage(err));
          setStatus("locked");
        }
      }
    })();
  }, [api]);

  const unlock = useCallback(
    async (file: File) => {
      const owner = ownerRef.current;
      if (!owner) return;
      const myGeneration = ++generation.current;
      setStatus("unlocking");
      setError(null);
      try {
        const onPhase = (index: number) => {
          if (generation.current !== myGeneration) return;
          setProgress({ label: PHASES[index], step: index + 1, total: PHASES.length });
        };
        const resolved = await new SessionResolver(file, owner, api, onPhase).resolve();
        if (generation.current !== myGeneration) return;
        setSession(resolved);
        setStatus("unlocked");
      } catch (err) {
        if (generation.current !== myGeneration) return;
        if (err instanceof AccessRequiredError) {
          // The session that let the mount-time probe succeed expired
          // in the meantime -- rare (tickets last 24 hours), but possible
          // for a tab left open. Re-probing on the next mount already
          // covers a fresh load; here, just send the owner back through
          // the same login path.
          setStatus("access-required");
        } else {
          setError(errorMessage(err));
          setStatus("locked");
        }
      } finally {
        if (generation.current === myGeneration) setProgress(null);
      }
    },
    [api],
  );

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
