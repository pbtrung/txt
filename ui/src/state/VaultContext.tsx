// Holds the unlocked session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen. Mirrors the shape of the
// historical (pre-rewrite) ui/src/state/VaultContext.tsx's status/progress
// state machine, but built on this rewrite's own data layer: Firebase
// sign-in -> the Worker's /v1/db-token -> AA -> the key-unwrap chain ->
// library index + bundle, no InstantDB and no per-document row reads here.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { signIn } from "../auth/firebaseSignIn";
import { WORKER_URL } from "../config";
import { loadBundle } from "../data/bundle";
import { parseBrowserCreds } from "../data/creds";
import { LibsqlClient } from "../data/libsql";
import { loadLibraryIndex } from "../data/libraryIndex";
import { R2Client } from "../data/r2";
import { readCredStore, readDbPrefix, readUmk, type CredStorePayload } from "../data/session";
import { fetchDbToken, fetchR2Token } from "../data/workerClient";
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
  "Connecting to your database",
  "Unwrapping keys",
  "Downloading your library",
] as const;

export interface VaultSession {
  aa: LibsqlClient;
  umk: Uint8Array;
  dbPrefix: string;
  credStore: CredStorePayload;
  r2: R2Client;
  libraryIndexBytes: Uint8Array | null;
  bundleBytes: Uint8Array | null;
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

// The browser client only ever unlocks its own account's AA, never the
// administrator's -- see the plan's "Manage screen: not built" scoping.
// cred_store's schema-by-account-type split (docs/data_model.md §3.6-3.7)
// only matters for the admin's own AA, which this app never opens.
const ACCOUNT_TYPE = "user";

async function resolveSession(file: File, onPhase: (index: number) => void): Promise<VaultSession> {
  onPhase(0);
  const creds = parseBrowserCreds(JSON.parse(await file.text()));
  onPhase(1);
  const { idToken, uid } = await signIn(creds.firebase_api_key, creds.firebase_email, creds.firebase_password);
  onPhase(2);
  const { dbToken, dbUrl } = await fetchDbToken(WORKER_URL, idToken);
  const aa = new LibsqlClient(dbUrl, dbToken);
  onPhase(3);
  const ikm = fromBase64(creds.user_root_key);
  const umk = await readUmk(aa, ikm);
  if (!umk) throw new Error("account not initialized yet -- run --init-db first");
  const [dbPrefix, credStore] = await Promise.all([readDbPrefix(aa, umk), readCredStore(aa, umk, ACCOUNT_TYPE, uid)]);
  onPhase(4);
  const r2Credential = await fetchR2Token(WORKER_URL, idToken, dbPrefix);
  const r2 = new R2Client(creds.r2_config, r2Credential);
  const [libraryIndexBytes, bundleBytes] = await Promise.all([
    loadLibraryIndex(aa, umk, dbPrefix, r2),
    loadBundle(aa, umk, dbPrefix, r2),
  ]);
  return { aa, umk, dbPrefix, credStore, r2, libraryIndexBytes, bundleBytes };
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
      const onPhase = (index: number) => setProgress({ label: PHASES[index], step: index + 1, total: PHASES.length });
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
    setSession(null);
    setStatus("locked");
    setError(null);
  }, []);

  const value = useMemo(() => ({ status, session, error, progress, unlock, lock }), [status, session, error, progress, unlock, lock]);
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault() must be used within a VaultProvider");
  return ctx;
}
