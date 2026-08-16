// Holds the unlocked session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { signIn } from "../auth/firebaseSignIn";
import { parseBrowserCreds, type BrowserCreds } from "../data/creds";
import { R2Client } from "../data/r2";
import { ensureSchema } from "../data/schema";
import { unwrapKeys } from "../data/session";
import { SqliteDatabase } from "../data/sqlite";
import { WorkerClient } from "../data/workerClient";
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
  db: SqliteDatabase;
  displayName: string;
  dbPrefix: string;
  r2: R2Client;
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

async function openDatabase(r2: R2Client, dbPath: string, dbMasterKey: Uint8Array) {
  const existing = await r2.getObject(dbPath);
  const db = existing
    ? await SqliteDatabase.openKeyed(dbMasterKey, existing)
    : await SqliteDatabase.openKeyed(dbMasterKey);
  try {
    ensureSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

class SessionResolver {
  constructor(
    private readonly file: File,
    private readonly onPhase: (index: number) => void,
  ) {}

  async resolve(): Promise<VaultSession> {
    const creds = await this.readCredentials();
    const worker = await this.authenticate(creds);
    this.onPhase(2);
    const keys = await worker.fetchKeys();
    this.onPhase(3);
    const { credStore } = await unwrapKeys(keys, creds.user_root_key);
    this.onPhase(4);
    const credential = await worker.fetchR2Token(
      credStore.db_path,
      credStore.db_prefix,
    );
    return this.openSession(credStore, credential);
  }

  private async readCredentials(): Promise<BrowserCreds> {
    this.onPhase(0);
    return parseBrowserCreds(JSON.parse(await this.file.text()));
  }

  private async authenticate(creds: BrowserCreds): Promise<WorkerClient> {
    this.onPhase(1);
    const session = await signIn(
      creds.firebase_api_key,
      creds.firebase_email,
      creds.firebase_password,
    );
    return new WorkerClient(session.idToken);
  }

  private async openSession(
    credStore: Awaited<ReturnType<typeof unwrapKeys>>["credStore"],
    credential: Awaited<ReturnType<WorkerClient["fetchR2Token"]>>,
  ): Promise<VaultSession> {
    const r2 = new R2Client(credential);
    const key = fromBase64(credStore.db_master_key);
    const db = await openDatabase(r2, credStore.db_path, key);
    return {
      db,
      displayName: credStore.display_name,
      dbPrefix: credStore.db_prefix,
      r2,
    };
  }
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  useEffect(() => () => session?.db.close(), [session]);

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    try {
      const onPhase = (index: number) =>
        setProgress({ label: PHASES[index], step: index + 1, total: PHASES.length });
      const resolved = await new SessionResolver(file, onPhase).resolve();
      setSession(resolved);
      setStatus("unlocked");
    } catch (err) {
      setError(errorMessage(err));
      setStatus("locked");
    } finally {
      setProgress(null);
    }
  }, []);

  const lock = useCallback(() => {
    session?.db.close();
    setSession(null);
    setStatus("locked");
    setError(null);
    setProgress(null);
  }, [session]);

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
