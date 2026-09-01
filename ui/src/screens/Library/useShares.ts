import { useCallback, useEffect, useState } from "react";
import type { LibraryDatabaseStore } from "../../data/databaseStore";
import { loadShares, type BookShare } from "../../data/shares";
import { errorMessage } from "../../util/errorMessage";

export function useShares(database: LibraryDatabaseStore | null) {
  const [shares, setShares] = useState<BookShare[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  const remove = useCallback(
    (id: number) => setShares((current) => current.filter((share) => share.id !== id)),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    if (database) {
      void database
        .read(loadShares)
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
  }, [database, revision]);
  return { shares, error, reload, remove };
}
