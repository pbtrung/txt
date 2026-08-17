// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { brotliCompress } from "../../../src/crypto/brotli";
import type { LibraryDatabaseStore } from "../../../src/data/databaseStore";
import { ensureSchema } from "../../../src/data/schema";
import { SqliteDatabase } from "../../../src/data/sqlite";
import { useLibraryBooks } from "../../../src/screens/Library/useLibraryBooks";

describe("useLibraryBooks", () => {
  function storeFor(db: SqliteDatabase): LibraryDatabaseStore {
    return {
      read: async (reader: (database: SqliteDatabase) => unknown) => reader(db),
    } as unknown as LibraryDatabaseStore;
  }

  it("returns [] immediately when there's no database yet", () => {
    const { result } = renderHook(() => useLibraryBooks(null));
    expect(result.current).toEqual({ status: "ready", books: [] });
  });

  it("loads real database bytes, starting from a loading (null) state", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    ensureSchema(db);
    const blob = await brotliCompress(
      new TextEncoder().encode(
        JSON.stringify({
          name: "dune.epub",
          title: "Dune",
          authors: [],
          subjects: [],
          publisher: null,
        }),
      ),
    );
    db.query(
      "INSERT INTO txt (txt_key, txt_prefix, path, catalog, last_accessed, created_at) " +
        "VALUES (x'00', x'00', x'00', ?, 0, 0)",
      [blob],
    );

    const store = storeFor(db);
    const { result } = renderHook(() => useLibraryBooks(store));
    expect(result.current).toEqual({ status: "loading" });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toEqual({
      status: "ready",
      books: [
        {
          txtId: 1,
          title: "Dune",
          authors: [],
          subjects: [],
          publisher: null,
        },
      ],
    });
    db.close();
  });

  it("surfaces database loading failures", async () => {
    const db = await SqliteDatabase.openUnkeyed();
    db.close();

    const store = storeFor(db);
    const { result } = renderHook(() => useLibraryBooks(store));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({
      status: "error",
      error: "database is closed",
    });
  });
});
