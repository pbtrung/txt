// Holds the unlocked session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
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
import { signIn } from "../auth/firebaseSignIn";
import { apiOrigin, parseBrowserCreds, type BrowserCreds } from "../data/creds";
import { ApiClient } from "../data/apiClient";
import type { R2SigningIdentity } from "../data/apiClient";
import { LibraryDatabaseStore } from "../data/databaseStore";
import { withNetworkRetries } from "../data/networkRequest";
import { R2Session } from "../data/r2Session";
import { RqliteClient } from "../data/rqlite";
import { unwrapKeys } from "../data/session";
import { fromBase64 } from "../util/base64";
import { errorMessage } from "../util/errorMessage";

type VaultStatus = "locked" | "unlocking" | "unlocked";

interface VaultProgress {
  label: string;
  step: number;
  total: number;
}

const PHASES = [
  "Reading credentials",
  "Signing in",
  "Fetching your keys",
  "Unwrapping keys",
  "Downloading your database",
] as const;

export interface VaultSession {
  database: LibraryDatabaseStore;
  storage: R2Session;
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
    const { api, uid } = await this.authenticate(creds);
    this.onPhase(2);
    const rqlite = new RqliteClient(
      creds.rqlite_db_url,
      creds.rqlite_admin_username,
      creds.rqlite_admin_password,
    );
    const [keys, ticket] = await Promise.all([
      withNetworkRetries((signal) => rqlite.fetchOwnerKeys(signal)),
      withNetworkRetries((signal) => api.fetchOwnerTicket(signal)),
    ]);
    requireMatchingOwner(uid, keys.uid, ticket.uid);
    this.onPhase(3);
    const { credStore, signing } = await unwrapKeys(
      keys,
      ticket.ticket,
      creds.user_root_key,
    );
    this.onPhase(4);
    const credential = await withNetworkRetries((signal) =>
      api.fetchR2Token(credStore.db_path, credStore.db_prefix, signing, signal),
    );
    return this.openSession(credStore, credential, api, signing);
  }

  private async readCredentials(): Promise<BrowserCreds> {
    this.onPhase(0);
    return parseBrowserCreds(JSON.parse(await this.file.text()));
  }

  private async authenticate(creds: BrowserCreds) {
    this.onPhase(1);
    const session = await withNetworkRetries((signal) =>
      signIn(
        creds.firebase_api_key,
        creds.firebase_email,
        creds.firebase_password,
        signal,
      ),
    );
    return { api: new ApiClient(session, apiOrigin(creds)), uid: session.uid };
  }

  private async openSession(
    credStore: Awaited<ReturnType<typeof unwrapKeys>>["credStore"],
    credentials: Awaited<ReturnType<ApiClient["fetchR2Token"]>>,
    api: ApiClient,
    signing: R2SigningIdentity,
  ): Promise<VaultSession> {
    const key = fromBase64(credStore.db_master_key);
    const storage = new R2Session(
      api,
      signing,
      credStore.db_path,
      credStore.db_prefix,
      credentials,
    );
    const database = await LibraryDatabaseStore.open(storage, key);
    return {
      database,
      storage,
      displayName: credStore.display_name,
      dbPrefix: credStore.db_prefix,
    };
  }
}

function requireMatchingOwner(...uids: string[]): void {
  if (new Set(uids).size !== 1) {
    throw new Error("Firebase, rqlite, and API owner identities do not match");
  }
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  useEffect(() => () => void session?.database.close(), [session]);

  // Guards against unlock()/lock() overlap: each call claims the next
  // generation, and an unlock() whose generation was superseded by a later
  // unlock()/lock() call before it resolved discards its result instead of
  // reviving a session the user already moved past (or stranding status at
  // "locked" while an old session stays open underneath it).
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
      if (generation.current !== myGeneration) {
        void resolved.database.close();
        return;
      }
      setSession(resolved);
      setStatus("unlocked");
    } catch (err) {
      if (generation.current !== myGeneration) return;
      setError(errorMessage(err));
      setStatus("locked");
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
