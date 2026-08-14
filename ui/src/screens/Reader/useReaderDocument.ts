// The session-selector hook for Reader: opens BB (docs/data_model.md §6.1,
// via openReaderBB.ts) for the current session, reads the requested
// document, and closes BB again on cleanup -- a fresh open per document
// visited, not one BB held open across the whole app lifetime.
import { useEffect, useState } from "react";
import { readDocument, type TxtDocument } from "../../data/document";
import { openReaderBB } from "../../data/openReaderBB";
import type { VaultSession } from "../../state/VaultContext";

export type ReaderStatus = "loading" | "ready" | "not-found" | "error";

export interface ReaderState {
  status: ReaderStatus;
  document: TxtDocument | null;
  error: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useReaderDocument(session: VaultSession | null, txtId: number): ReaderState {
  const [state, setState] = useState<ReaderState>({ status: "loading", document: null, error: null });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ status: "loading", document: null, error: null });
    let openBb: { close(): void } | null = null;

    openReaderBB({ aa: session.aa, dbMasterKeyBase64: session.credStore.db_master_key, bundleBytes: session.bundleBytes })
      .then(async (bb) => {
        if (cancelled) {
          bb.close();
          return;
        }
        openBb = bb;
        const doc = await readDocument(bb, txtId);
        if (!cancelled) setState(doc ? { status: "ready", document: doc, error: null } : { status: "not-found", document: null, error: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", document: null, error: errorMessage(err) });
      });

    return () => {
      cancelled = true;
      openBb?.close();
    };
  }, [session, txtId]);

  return state;
}
