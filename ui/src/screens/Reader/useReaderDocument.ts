// The session-selector hook for Reader: loads the requested txt row's
// content from the unlocked session's already-open SqliteDatabase + R2Client.
import { useEffect, useState } from "react";
import {
  loadReaderDocument,
  READER_LOAD_TOTAL_STEPS,
  type ReaderDocument,
  type ReaderLoadProgress,
} from "../../data/readerDocument";
import type { VaultSession } from "../../state/VaultContext";
import { errorMessage } from "../../util/errorMessage";

type ReaderState =
  | {
      status: "loading";
      document: null;
      error: null;
      progress: ReaderLoadProgress;
    }
  | { status: "ready"; document: ReaderDocument; error: null }
  | { status: "not-found"; document: null; error: null }
  | { status: "error"; document: null; error: string };

interface LoadedReader {
  session: VaultSession;
  txtId: number;
  state: ReaderState;
}

interface PendingReaderLoad {
  promise: Promise<ReaderDocument | null>;
  progress: ReaderLoadProgress;
  listeners: Set<(progress: ReaderLoadProgress) => void>;
}

const PENDING_LOADS = new WeakMap<VaultSession, Map<number, PendingReaderLoad>>();

const INITIAL_PROGRESS: ReaderLoadProgress = {
  label: "Reading book details",
  step: 1,
  total: READER_LOAD_TOTAL_STEPS,
};
const LOADING: ReaderState = {
  status: "loading",
  document: null,
  error: null,
  progress: INITIAL_PROGRESS,
};
const NOT_FOUND: ReaderState = {
  status: "not-found",
  document: null,
  error: null,
};

export function useReaderDocument(
  session: VaultSession | null,
  txtId: number,
): ReaderState {
  const [loaded, setLoaded] = useState<LoadedReader | null>(null);
  useEffect(() => {
    if (!session || !validTxtId(txtId)) return;
    const source = session;
    let cancelled = false;
    loadState(source, txtId, (progress) => {
      if (!cancelled) {
        setLoaded({ session: source, txtId, state: loading(progress) });
      }
    }).then((state) => {
      if (!cancelled) setLoaded({ session: source, txtId, state });
    });
    return () => {
      cancelled = true;
    };
  }, [session, txtId]);
  if (!session) return LOADING;
  if (!validTxtId(txtId)) return NOT_FOUND;
  return loaded?.session === session && loaded.txtId === txtId ? loaded.state : LOADING;
}

function loading(progress: ReaderLoadProgress): ReaderState {
  return { status: "loading", document: null, error: null, progress };
}

function validTxtId(txtId: number): boolean {
  return Number.isSafeInteger(txtId) && txtId > 0;
}

async function loadState(
  session: VaultSession,
  txtId: number,
  onProgress: (progress: ReaderLoadProgress) => void,
): Promise<ReaderState> {
  try {
    const document = await loadOnce(session, txtId, onProgress);
    return document ? { status: "ready", document, error: null } : NOT_FOUND;
  } catch (error) {
    return { status: "error", document: null, error: errorMessage(error) };
  }
}

function loadOnce(
  session: VaultSession,
  txtId: number,
  onProgress: (progress: ReaderLoadProgress) => void,
): Promise<ReaderDocument | null> {
  let sessionLoads = PENDING_LOADS.get(session);
  if (!sessionLoads) {
    sessionLoads = new Map();
    PENDING_LOADS.set(session, sessionLoads);
  }
  const existing = sessionLoads.get(txtId);
  if (existing) {
    existing.listeners.add(onProgress);
    onProgress(existing.progress);
    return existing.promise;
  }

  const listeners = new Set([onProgress]);
  const pending = {} as PendingReaderLoad;
  const report = (progress: ReaderLoadProgress) => {
    pending.progress = progress;
    for (const listener of listeners) listener(progress);
  };
  pending.progress = INITIAL_PROGRESS;
  pending.listeners = listeners;
  pending.promise = session.database
    .read((db) =>
      loadReaderDocument(db, session.storage, session.dbPrefix, txtId, report),
    )
    .finally(() => {
      if (sessionLoads.get(txtId) === pending) sessionLoads.delete(txtId);
      if (sessionLoads.size === 0) PENDING_LOADS.delete(session);
    });
  sessionLoads.set(txtId, pending);
  return pending.promise;
}
