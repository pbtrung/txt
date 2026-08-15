// The session-selector hook for Reader: loads the requested txt row's
// content from the unlocked session's already-open SqliteDatabase + R2Client.
import { useEffect, useState } from "react";
import { loadReaderDocument, type ReaderDocument } from "../../data/readerDocument";
import type { VaultSession } from "../../state/VaultContext";

export type ReaderStatus = "loading" | "ready" | "not-found" | "error";

export interface ReaderState {
  status: ReaderStatus;
  document: ReaderDocument | null;
  error: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useReaderDocument(
  session: VaultSession | null,
  txtId: number,
): ReaderState {
  const [state, setState] = useState<ReaderState>({
    status: "loading",
    document: null,
    error: null,
  });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading", document: null, error: null });

    loadReaderDocument(session.db, session.r2, session.dbPrefix, txtId)
      .then((doc) => {
        if (cancelled) return;
        setState(
          doc
            ? { status: "ready", document: doc, error: null }
            : { status: "not-found", document: null, error: null },
        );
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({ status: "error", document: null, error: errorMessage(err) });
      });

    return () => {
      cancelled = true;
    };
  }, [session, txtId]);

  return state;
}
