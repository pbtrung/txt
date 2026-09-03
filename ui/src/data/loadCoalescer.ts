// Shared "coalesce concurrent loads for the same key, broadcast progress"
// logic: useReaderDocument.ts and useSharedReaderDocument.ts both need a
// second caller for the same document (e.g. a second render before the
// first load settles) to join the in-flight request and its progress
// updates rather than starting a duplicate one.
import type { ReaderLoadProgress } from "./readerDocument";

interface Pending<V> {
  promise: Promise<V>;
  progress: ReaderLoadProgress;
  listeners: Set<(progress: ReaderLoadProgress) => void>;
}

export interface LoadCoalescer<K, V> {
  /** Runs `load` for `key`, or joins an already-in-flight load for the
   * same key, broadcasting progress to every caller currently waiting on
   * it. The pending entry is removed once the load settles, so a later
   * call for the same key starts a fresh load. */
  run(
    key: K,
    onProgress: (progress: ReaderLoadProgress) => void,
    initialProgress: ReaderLoadProgress,
    load: (report: (progress: ReaderLoadProgress) => void) => Promise<V>,
  ): Promise<V>;
}

export function createLoadCoalescer<K, V>(): LoadCoalescer<K, V> {
  const pending = new Map<K, Pending<V>>();
  return {
    run(key, onProgress, initialProgress, load) {
      const existing = pending.get(key);
      if (existing) {
        existing.listeners.add(onProgress);
        onProgress(existing.progress);
        return existing.promise;
      }
      const listeners = new Set([onProgress]);
      const entry = {} as Pending<V>;
      entry.progress = initialProgress;
      entry.listeners = listeners;
      entry.promise = load((progress) => {
        entry.progress = progress;
        for (const listener of listeners) listener(progress);
      }).finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
      pending.set(key, entry);
      return entry.promise;
    },
  };
}
