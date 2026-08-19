import { useCallback, useEffect, useState } from "react";
import type { LibraryDatabaseStore } from "../../data/databaseStore";
import { loadShares, type BookShare } from "../../data/shares";

export function useShares(database: LibraryDatabaseStore | null) {
  const [shares, setShares] = useState<BookShare[]>([]);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    if (database) {
      void database.read(loadShares).then((value) => {
        if (!cancelled) setShares(value);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [database, revision]);
  return { shares, reload };
}
