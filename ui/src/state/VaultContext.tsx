// Holds the unlocked session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { signIn } from "../auth/firebaseSignIn";
import { parseBrowserCreds } from "../data/creds";
import { R2Client } from "../data/r2";
import { ensureSchema } from "../data/schema";
import { unwrapKeys } from "../data/session";
import { SqliteDatabase } from "../data/sqlite";
import { WorkerClient } from "../data/workerClient";
import { fromBase64 } from "../util/base64";

export type VaultStatus = "locked" | "unlocking" | "unlocked";

export interface VaultProgress {
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
  dbPath: string;
  dbPrefix: string;
  r2: R2Client;
}

export interface VaultContextValue {
  status: VaultStatus;
  session: VaultSession | null;
  error: string | null;
  progress: VaultProgress | null;
  unlock: (file: File) => Promise<void>;
  lock: () => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function openDatabase(r2: R2Client, dbPath: string, dbMasterKey: Uint8Array) {
  const existing = await r2.getObject(dbPath);
  const db = existing
    ? await SqliteDatabase.openKeyed(dbMasterKey, existing)
    : await SqliteDatabase.openKeyed(dbMasterKey);
  ensureSchema(db);
  return db;
}

async function resolveSession(
  file: File,
  onPhase: (index: number) => void,
): Promise<VaultSession> {
  onPhase(0);
  const creds = parseBrowserCreds(JSON.parse(await file.text()));
  onPhase(1);
  const { idToken } = await signIn(
    creds.firebase_api_key,
    creds.firebase_email,
    creds.firebase_password,
  );
  const worker = new WorkerClient(creds.cf_worker_url, idToken);
  onPhase(2);
  const keys = await worker.fetchKeys();
  onPhase(3);
  const { credStore } = await unwrapKeys(keys, creds.user_root_key);
  onPhase(4);
  const credential = await worker.fetchR2Token(credStore.db_path, credStore.db_prefix);
  const r2 = new R2Client(credential);
  const db = await openDatabase(
    r2,
    credStore.db_path,
    fromBase64(credStore.db_master_key),
  );
  return {
    db,
    displayName: credStore.display_name,
    dbPath: credStore.db_path,
    dbPrefix: credStore.db_prefix,
    r2,
  };
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<VaultProgress | null>(null);

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    try {
      const onPhase = (index: number) =>
        setProgress({ label: PHASES[index], step: index + 1, total: PHASES.length });
      const resolved = await resolveSession(file, onPhase);
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
    setSession((current) => {
      current?.db.close();
      return null;
    });
    setStatus("locked");
    setError(null);
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
