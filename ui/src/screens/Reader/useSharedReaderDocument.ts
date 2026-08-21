import { useEffect, useState } from "react";
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

interface PendingLoad {
  progress: ReaderLoadProgress;
  promise: Promise<ReaderDocument>;
  listeners: Set<(progress: ReaderLoadProgress) => void>;
}

const PENDING_LOADS = new Map<string, PendingLoad>();
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
  const key = `${reference.apiBaseUrl}.${reference.id}.${toBase64(reference.contentKey)}`;
  const existing = PENDING_LOADS.get(key);
  if (existing) {
    existing.listeners.add(onProgress);
    onProgress(existing.progress);
    return existing.promise;
  }
  const listeners = new Set([onProgress]);
  const pending = {} as PendingLoad;
  const report = (progress: ReaderLoadProgress) => {
    pending.progress = progress;
    for (const listener of listeners) listener(progress);
  };
  pending.progress = INITIAL_PROGRESS;
  pending.listeners = listeners;
  pending.promise = loadSharedReaderDocument(reference, report).finally(() => {
    if (PENDING_LOADS.get(key) === pending) PENDING_LOADS.delete(key);
  });
  PENDING_LOADS.set(key, pending);
  return pending.promise;
}

function loading(progress: ReaderLoadProgress): SharedReaderState {
  return { status: "loading", document: null, error: null, progress };
}
