// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { brotliCompress } from "../../../src/crypto/brotli";
import { ensureSchema } from "../../../src/data/schema";
import { SqliteDatabase } from "../../../src/data/sqlite";
import { useLibraryBooks } from "../../../src/screens/Library/useLibraryBooks";

describe("useLibraryBooks", () => {
  it("returns [] immediately when there's no database yet", () => {
    const { result } = renderHook(() => useLibraryBooks(null));
    expect(result.current).toEqual([]);
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

    const { result } = renderHook(() => useLibraryBooks(db));
    expect(result.current).toBeNull();

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual([
      {
        txtId: 1,
        title: "Dune",
        sortKey: null,
        authors: [],
        subjects: [],
        publisher: null,
      },
    ]);
    db.close();
  });
});
