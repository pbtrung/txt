import { useEffect, useState } from "react";
import { createLoadCoalescer } from "../../data/loadCoalescer";
import {
  loadSharedReaderDocument,
  SHARED_READER_LOAD_TOTAL_STEPS,
  type SharedReference,
} from "../../data/sharedReader";
import type { ReaderDocument, ReaderLoadProgress } from "../../data/readerDocument";
import { toBase64 } from "../../util/base64";
import { errorMessage } from "../../util/errorMessage";

type SharedReaderState =
  | {
      status: "loading";
      document: null;
      error: null;
      progress: ReaderLoadProgress;
    }
  | { status: "ready"; document: ReaderDocument; error: null }
  | { status: "invalid"; document: null; error: null }
  | { status: "error"; document: null; error: string };

const COALESCER = createLoadCoalescer<string, ReaderDocument>();
const INITIAL_PROGRESS: ReaderLoadProgress = {
  label: "Requesting shared book",
  step: 1,
  total: SHARED_READER_LOAD_TOTAL_STEPS,
};

export function useSharedReaderDocument(
  reference: SharedReference | null,
): SharedReaderState {
  const [loaded, setLoaded] = useState<{
    reference: SharedReference;
    state: SharedReaderState;
  } | null>(null);
  useEffect(() => {
    if (!reference) return;
    const source = reference;
    let active = true;
    loadOnce(source, (progress) => {
      if (active) setLoaded({ reference: source, state: loading(progress) });
    }).then(
      (document) => {
        if (active)
          setLoaded({
            reference: source,
            state: { status: "ready", document, error: null },
          });
      },
      (error: unknown) => {
        if (active)
          setLoaded({
            reference: source,
            state: { status: "error", document: null, error: errorMessage(error) },
          });
      },
    );
    return () => {
      active = false;
    };
  }, [reference]);
  if (!reference) return { status: "invalid", document: null, error: null };
  return loaded?.reference === reference ? loaded.state : loading(INITIAL_PROGRESS);
}

function loadOnce(
  reference: SharedReference,
  onProgress: (progress: ReaderLoadProgress) => void,
): Promise<ReaderDocument> {
  const key = `${reference.id}.${toBase64(reference.contentKey)}`;
  return COALESCER.run(key, onProgress, INITIAL_PROGRESS, (report) =>
    loadSharedReaderDocument(reference, report),
  );
}

function loading(progress: ReaderLoadProgress): SharedReaderState {
  return { status: "loading", document: null, error: null, progress };
}
