// Holds the unlocked vault session in memory only -- never persisted to
// localStorage/sessionStorage -- for the lifetime of the page. A reload
// always lands back on the Unlock screen.

import type { Client } from "@libsql/core/api";
import type { AwsClient } from "aws4fetch";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import { checkPassword, fetchR2Config, resolveUserId, unwrapTxtKey, unwrapUmk } from "../data/owner";
import { createDb } from "../data/db";
import { createR2Client } from "../data/r2";
import { parseCreds, type Creds } from "../data/creds";
import type { R2Config } from "../data/r2Config";

export type VaultStatus = "locked" | "unlocking" | "unlocked";

export interface VaultSession {
  creds: Creds;
  db: Client;
  userId: number;
  umk: Uint8Array;
  r2Config: R2Config;
  r2Client: AwsClient;
}

export interface VaultContextValue {
  status: VaultStatus;
  session: VaultSession | null;
  error: string | null;
  unlock: (file: File) => Promise<void>;
  lock: () => void;
  getTxtKey: (txtId: number) => Promise<Uint8Array>;
}

const VaultContext = createContext<VaultContextValue | null>(null);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus>("locked");
  const [session, setSession] = useState<VaultSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const txtKeyCache = useRef(new Map<number, Uint8Array>());

  const unlock = useCallback(async (file: File) => {
    setStatus("unlocking");
    setError(null);
    try {
      const text = await file.text();
      const creds = parseCreds(JSON.parse(text));

      const db = createDb(creds);
      const userId = await resolveUserId(db, creds);

      const passwordOk = await checkPassword(db, userId, creds.password);
      if (!passwordOk) {
        throw new Error("Incorrect password for this account.");
      }

      const umk = await unwrapUmk(db, creds, userId);
      const r2Config = await fetchR2Config(db, userId, umk);
      const r2Client = createR2Client(r2Config);

      txtKeyCache.current = new Map();
      setSession({ creds, db, userId, umk, r2Config, r2Client });
      setStatus("unlocked");
    } catch (err) {
      setSession(null);
      setStatus("locked");
      setError(errorMessage(err) || "Failed to unlock your library.");
    }
  }, []);

  const lock = useCallback(() => {
    txtKeyCache.current = new Map();
    setSession(null);
    setStatus("locked");
    setError(null);
  }, []);

  const getTxtKey = useCallback(
    async (txtId: number): Promise<Uint8Array> => {
      const cached = txtKeyCache.current.get(txtId);
      if (cached) return cached;
      if (!session) {
        throw new Error("vault is locked");
      }
      const txtKey = await unwrapTxtKey(session.db, txtId, session.umk);
      txtKeyCache.current.set(txtId, txtKey);
      return txtKey;
    },
    [session],
  );

  const value = useMemo<VaultContextValue>(
    () => ({ status, session, error, unlock, lock, getTxtKey }),
    [status, session, error, unlock, lock, getTxtKey],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error("useVault() must be used within a VaultProvider");
  }
  return ctx;
}
