// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildSqliteFixture } from "../../testUtils/sqliteFixture";
import { useLibraryBooks } from "./useLibraryBooks";

const SCHEMA_SQL = `
  CREATE TABLE doc (txt_id INTEGER PRIMARY KEY, title TEXT NOT NULL, sort_key TEXT);
  CREATE TABLE term (id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, name TEXT NOT NULL);
  CREATE UNIQUE INDEX idx_term_kind_name ON term(kind, name);
  CREATE TABLE doc_term (doc_id INTEGER NOT NULL, kind INTEGER NOT NULL, ord INTEGER NOT NULL,
      term_id INTEGER NOT NULL, PRIMARY KEY (doc_id, kind, ord)) WITHOUT ROWID;
`;

describe("useLibraryBooks", () => {
  it("returns [] immediately when there are no bytes yet", () => {
    const { result } = renderHook(() => useLibraryBooks(null));
    expect(result.current).toEqual([]);
  });

  it("loads real library index bytes, starting from a loading (null) state", async () => {
    const bytes = await buildSqliteFixture([SCHEMA_SQL, "INSERT INTO doc (txt_id, title, sort_key) VALUES (1, 'Dune', 'Dune');"]);

    const { result } = renderHook(() => useLibraryBooks(bytes));
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual([{ txtId: 1, title: "Dune", sortKey: "Dune", authors: [], subjects: [], publisher: null }]);
  });
});
