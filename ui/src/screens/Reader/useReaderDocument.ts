// The session-selector hook for Reader: loads the requested txt row's
// content from the unlocked session's already-open SqliteDatabase + R2Client.
import { useEffect, useState } from "react";
import { loadReaderDocument, type ReaderDocument } from "../../data/readerDocument";
import type { VaultSession } from "../../state/VaultContext";
import { errorMessage } from "../../util/errorMessage";

type ReaderState =
  | { status: "loading"; document: null; error: null }
  | { status: "ready"; document: ReaderDocument; error: null }
  | { status: "not-found"; document: null; error: null }
  | { status: "error"; document: null; error: string };

interface LoadedReader {
  session: VaultSession;
  txtId: number;
  state: ReaderState;
}

const LOADING: ReaderState = { status: "loading", document: null, error: null };
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
    loadState(source, txtId).then((state) => {
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

function validTxtId(txtId: number): boolean {
  return Number.isSafeInteger(txtId) && txtId > 0;
}

async function loadState(session: VaultSession, txtId: number): Promise<ReaderState> {
  try {
    const document = await session.database.read((db) =>
      loadReaderDocument(db, session.storage, session.dbPrefix, txtId),
    );
    return document ? { status: "ready", document, error: null } : NOT_FOUND;
  } catch (error) {
    return { status: "error", document: null, error: errorMessage(error) };
  }
}
