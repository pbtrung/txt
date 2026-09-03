// The session-selector hook for Reader: loads the requested document's
// content through the unlocked session's LibraryStore + R2Session.
import { useEffect, useState } from "react";
import { createLoadCoalescer, type LoadCoalescer } from "../../data/loadCoalescer";
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

const COALESCERS = new WeakMap<
  VaultSession,
  LoadCoalescer<number, ReaderDocument | null>
>();

function coalescerFor(
  session: VaultSession,
): LoadCoalescer<number, ReaderDocument | null> {
  let coalescer = COALESCERS.get(session);
  if (!coalescer) {
    coalescer = createLoadCoalescer();
    COALESCERS.set(session, coalescer);
  }
  return coalescer;
}

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
  return coalescerFor(session).run(txtId, onProgress, INITIAL_PROGRESS, (report) =>
    loadReaderDocument(
      session.library,
      session.storage,
      session.dbPrefix,
      txtId,
      report,
    ),
  );
}
