import { useCallback, useEffect, useState } from "react";
import { loadShares, type BookShare } from "../../data/shares";
import type { VaultSession } from "../../state/VaultContext";
import { errorMessage } from "../../util/errorMessage";

export function useShares(session: VaultSession | null) {
  const [shares, setShares] = useState<BookShare[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const remove = useCallback(
    (shareIdHash: string) =>
      setShares((current) =>
        current.filter((share) => share.shareIdHash !== shareIdHash),
      ),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    if (session) {
      void loadShares(session, session.library.snapshot(), session.umk)
        .then((value) => {
          if (!cancelled) {
            setShares(value);
            setError(null);
          }
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setError(errorMessage(loadError));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [session, revision]);
  return { shares, error, reload, remove };
}
