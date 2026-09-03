// The schema in worker/migrations/ applied against a real D1 binding (not
// a mocked SQLite), specifically targeting the correctness issues
// docs/data_model.md flags -- confirm they're actually enforced, not just
// documented.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function blob(length = 8): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function insertKey(purpose: string): Promise<number> {
  const { meta } = await env.DB.prepare(
    "INSERT INTO key_store (purpose, wrapped_key, created_at) VALUES (?, ?, ?)",
  )
    .bind(purpose, blob(), Date.now())
    .run();
  return meta.last_row_id;
}

async function insertDocument(): Promise<number> {
  const contentKeyId = await insertKey("content_key");
  const accessKeyId = await insertKey("access_key");
  const { meta } = await env.DB.prepare(
    `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(Date.now(), contentKeyId, blob(), accessKeyId, blob())
    .run();
  return meta.last_row_id;
}

async function insertDocumentWithoutAccess(): Promise<number> {
  const contentKeyId = await insertKey("content_key");
  const { meta } = await env.DB.prepare(
    "INSERT INTO documents (created_at, content_key_id, content_blob) VALUES (?, ?, ?)",
  )
    .bind(Date.now(), contentKeyId, blob())
    .run();
  return meta.last_row_id;
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe("key_store purpose enforcement", () => {
  it("aborts a documents insert whose content_key_id has the wrong purpose", async () => {
    const wrongPurposeKeyId = await insertKey("access_key"); // should be content_key
    const accessKeyId = await insertKey("access_key");
    await expect(
      env.DB.prepare(
        `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(Date.now(), wrongPurposeKeyId, blob(), accessKeyId, blob())
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for documents row/);
  });

  it("aborts a documents insert whose access_key_id has the wrong purpose", async () => {
    const contentKeyId = await insertKey("content_key");
    const wrongPurposeKeyId = await insertKey("content_key"); // should be access_key
    await expect(
      env.DB.prepare(
        `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(Date.now(), contentKeyId, blob(), wrongPurposeKeyId, blob())
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for documents row/);
  });

  // The specific regression docs/data_model.md §2 calls out: `!=` against a
  // NULL subquery result (no key_store row at all) evaluates to NULL, not
  // true, and a trigger WHEN clause that evaluates to NULL does not fire --
  // so `!=` would let a dangling reference slip through uncaught. `IS NOT`
  // is NULL-safe. This asserts on the trigger's own error message
  // specifically (not just "some error"), so a regression back to `!=`
  // would make this test fail by *not* throwing at all, rather than by
  // throwing a different, generic constraint error.
  it("aborts a documents insert whose content_key_id references no key_store row at all", async () => {
    const accessKeyId = await insertKey("access_key");
    await expect(
      env.DB.prepare(
        `INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id, access_blob)
         VALUES (?, 999999, ?, ?, ?)`,
      )
        .bind(Date.now(), blob(), accessKeyId, blob())
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for documents row/);
  });

  it("aborts a bookmarks insert whose key_id has the wrong purpose", async () => {
    const documentId = await insertDocument();
    const wrongPurposeKeyId = await insertKey("share_key");
    await expect(
      env.DB.prepare(
        "INSERT INTO bookmarks (document_id, created_at, key_id, bookmark_blob) VALUES (?, ?, ?, ?)",
      )
        .bind(documentId, Date.now(), wrongPurposeKeyId, blob())
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for bookmarks row/);
  });

  it("aborts a shares insert whose key_id has the wrong purpose", async () => {
    const documentId = await insertDocument();
    const wrongPurposeKeyId = await insertKey("bookmark_key");
    await expect(
      env.DB.prepare(
        `INSERT INTO shares (share_id_hash, document_id, object_path_hash, key_id, owner_blob, state, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      )
        .bind(blob(32), documentId, blob(32), wrongPurposeKeyId, blob(), Date.now())
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for shares row/);
  });

  it("aborts a catalog insert whose key_id has the wrong purpose", async () => {
    const wrongPurposeKeyId = await insertKey("content_key");
    await expect(
      env.DB.prepare(
        "INSERT INTO catalog (singleton, key_id, catalog_blob, updated_at) VALUES (1, ?, ?, ?)",
      )
        .bind(wrongPurposeKeyId, blob(), Date.now())
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for catalog row/);
  });
});

describe("documents.access_key_id/access_blob nullability", () => {
  it("allows inserting a document with no access state at all", async () => {
    const documentId = await insertDocumentWithoutAccess();
    const row = await env.DB.prepare(
      "SELECT access_key_id, access_blob FROM documents WHERE id = ?",
    )
      .bind(documentId)
      .first<{ access_key_id: number | null; access_blob: ArrayBuffer | null }>();
    expect(row?.access_key_id).toBeNull();
    expect(row?.access_blob).toBeNull();
  });

  it("rejects an insert with access_blob but no access_key_id", async () => {
    const contentKeyId = await insertKey("content_key");
    await expect(
      env.DB.prepare(
        "INSERT INTO documents (created_at, content_key_id, content_blob, access_blob) VALUES (?, ?, ?, ?)",
      )
        .bind(Date.now(), contentKeyId, blob(), blob())
        .run(),
    ).rejects.toThrow();
  });

  it("rejects an insert with access_key_id but no access_blob", async () => {
    const contentKeyId = await insertKey("content_key");
    const accessKeyId = await insertKey("access_key");
    await expect(
      env.DB.prepare(
        "INSERT INTO documents (created_at, content_key_id, content_blob, access_key_id) VALUES (?, ?, ?, ?)",
      )
        .bind(Date.now(), contentKeyId, blob(), accessKeyId)
        .run(),
    ).rejects.toThrow();
  });

  it("aborts an update that gives access_key_id the wrong purpose", async () => {
    const documentId = await insertDocumentWithoutAccess();
    const wrongPurposeKeyId = await insertKey("content_key"); // should be access_key
    await expect(
      env.DB.prepare(
        "UPDATE documents SET access_key_id = ?, access_blob = ? WHERE id = ?",
      )
        .bind(wrongPurposeKeyId, blob(), documentId)
        .run(),
    ).rejects.toThrow(/key_store purpose mismatch for documents row/);
  });

  it("deletes the old access_key row when access_key_id is cleared back to NULL", async () => {
    const documentId = await insertDocument();
    const before = await countRows("key_store");
    await env.DB.prepare(
      "UPDATE documents SET access_key_id = NULL, access_blob = NULL WHERE id = ?",
    )
      .bind(documentId)
      .run();
    const after = await countRows("key_store");
    expect(after).toBe(before - 1); // access_key gone, content_key untouched
  });

  it("deletes only the content_key row for a document with no access state", async () => {
    const documentId = await insertDocumentWithoutAccess();
    const before = await countRows("key_store");
    await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(documentId).run();
    const after = await countRows("key_store");
    expect(after).toBe(before - 1);
  });
});

describe("key_store cleanup on delete", () => {
  it("deletes a document's content_key and access_key rows when the document is deleted", async () => {
    const documentId = await insertDocument();
    const before = await countRows("key_store");
    await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(documentId).run();
    const after = await countRows("key_store");
    expect(after).toBe(before - 2);
  });

  it("deletes a share's key_store row when the share is deleted", async () => {
    const documentId = await insertDocument();
    const keyId = await insertKey("share_key");
    await env.DB.prepare(
      `INSERT INTO shares (share_id_hash, document_id, object_path_hash, key_id, owner_blob, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
      .bind(blob(32), documentId, blob(32), keyId, blob(), Date.now())
      .run();
    const before = await countRows("key_store");
    await env.DB.prepare("DELETE FROM shares WHERE key_id = ?").bind(keyId).run();
    const after = await countRows("key_store");
    expect(after).toBe(before - 1);
  });

  it("keeps at most 20 bookmarks per document and leaves no orphaned key_store rows for evicted ones", async () => {
    const documentId = await insertDocument();
    const keyStoreBefore = await countRows("key_store");
    for (let i = 0; i < 25; i++) {
      const keyId = await insertKey("bookmark_key");
      await env.DB.prepare(
        "INSERT INTO bookmarks (document_id, created_at, key_id, bookmark_blob) VALUES (?, ?, ?, ?)",
      )
        .bind(documentId, Date.now() + i, keyId, blob())
        .run();
    }
    const bookmarkCount = await env.DB.prepare(
      "SELECT count(*) AS n FROM bookmarks WHERE document_id = ?",
    )
      .bind(documentId)
      .first<{ n: number }>();
    expect(bookmarkCount?.n).toBe(20);

    // 25 bookmark_key rows were inserted; the cap trigger evicted 5 bookmark
    // rows, and trg_bookmarks_delete_key must have deleted their key_store
    // rows too -- so key_store should have grown by exactly 20 (25 minted,
    // 5 cleaned up), not 25.
    const keyStoreAfter = await countRows("key_store");
    expect(keyStoreAfter).toBe(keyStoreBefore + 20);
  });
});

describe("shares.document_id ON DELETE RESTRICT", () => {
  it("rejects deleting a document referenced by an active share", async () => {
    const documentId = await insertDocument();
    const keyId = await insertKey("share_key");
    await env.DB.prepare(
      `INSERT INTO shares (share_id_hash, document_id, object_path_hash, key_id, owner_blob, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
      .bind(blob(32), documentId, blob(32), keyId, blob(), Date.now())
      .run();

    await expect(
      env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(documentId).run(),
    ).rejects.toThrow();
  });
});

describe("bookmarks.document_id ON DELETE CASCADE", () => {
  it("deletes a document's bookmarks (and their key_store rows) when the document is deleted", async () => {
    const documentId = await insertDocument();
    const keyId = await insertKey("bookmark_key");
    await env.DB.prepare(
      "INSERT INTO bookmarks (document_id, created_at, key_id, bookmark_blob) VALUES (?, ?, ?, ?)",
    )
      .bind(documentId, Date.now(), keyId, blob())
      .run();

    await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(documentId).run();

    const remainingBookmarks = await env.DB.prepare(
      "SELECT count(*) AS n FROM bookmarks WHERE document_id = ?",
    )
      .bind(documentId)
      .first<{ n: number }>();
    expect(remainingBookmarks?.n).toBe(0);

    // The bookmark's own key_id row must be gone too: CASCADE deletes the
    // bookmark row, which fires trg_bookmarks_delete_key.
    const remainingKey = await env.DB.prepare("SELECT id FROM key_store WHERE id = ?")
      .bind(keyId)
      .first();
    expect(remainingKey).toBeNull();
  });
});
