import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/db", () => ({ createDb: vi.fn(() => ({ execute: vi.fn() })) }));
vi.mock("../data/r2", () => ({ createR2Client: vi.fn(() => ({ fetch: vi.fn() })) }));
vi.mock("../data/owner", () => ({
  resolveUserId: vi.fn(),
  checkPassword: vi.fn(),
  unwrapUmk: vi.fn(),
  unwrapTxtKey: vi.fn(),
  fetchR2Config: vi.fn(),
}));
vi.mock("../data/metadata", () => ({ loadTxtMetadata: vi.fn() }));
vi.mock("../data/access", () => ({
  loadOrInitAccess: vi.fn(),
  setReadPosition: vi.fn(),
  removeAccessEntry: vi.fn(),
}));
vi.mock("../data/bookmarks", () => ({
  loadOrInitBookmarks: vi.fn(),
  addBookmark: vi.fn(),
  removeBookmark: vi.fn(),
}));

import * as accessData from "../data/access";
import * as bookmarksData from "../data/bookmarks";
import * as metadata from "../data/metadata";
import * as owner from "../data/owner";
import { useVault } from "./vault";

/** Wires up the three post-auth loads (metadata/access/bookmarks) that
 * unlock() now performs, so a successful-unlock test doesn't need to spell
 * this out every time. */
function mockLibraryLoads() {
  vi.mocked(metadata.loadTxtMetadata).mockResolvedValue(new Map());
  vi.mocked(accessData.loadOrInitAccess).mockResolvedValue({ txtAccessKey: new Uint8Array(64), accessMap: new Map() });
  vi.mocked(bookmarksData.loadOrInitBookmarks).mockResolvedValue({
    bookmarkKey: new Uint8Array(64),
    bookmarksMap: new Map(),
  });
}

const CONFIG = {
  turso_database_url: "libsql://example",
  turso_auth_token: "token",
  username: "alice",
  username_lookup_key: btoa("x".repeat(32)),
  password: "hunter2",
  display_name: "Alice",
  user_root_key: btoa("x".repeat(256)),
};

function fakeFile(contents: unknown): File {
  return new File([JSON.stringify(contents)], "config.json", { type: "application/json" });
}

// state/vault.ts is a module-level singleton (see its own comment for why),
// so -- unlike the old per-test VaultProvider instance -- its state
// persists across test cases in this same file unless reset. lock() already
// resets every piece of state unlock()/lock() itself touches, so reusing it
// here is enough; no separate test-only reset export needed.
const vault = useVault();

describe("vault", () => {
  beforeEach(() => {
    vault.lock();
    // verbose logging defaults to on (see src/log.ts) -- unlock() logs each
    // of its steps unconditionally, so silence that rather than let it
    // clutter every test run's output.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks successfully when every step succeeds", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(true);
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    expect(vault.status.value).toBe("locked");

    await vault.unlock(fakeFile(CONFIG));

    expect(vault.status.value).toBe("unlocked");
    expect(vault.session.value?.userId).toBe(42);
    expect(vault.session.value?.creds.displayName).toBe("Alice");
    expect(vault.error.value).toBeNull();
  });

  it("stays locked and reports an error for an invalid config file", async () => {
    await vault.unlock(fakeFile({ not: "a valid config" }));

    expect(vault.status.value).toBe("locked");
    expect(vault.session.value).toBeNull();
    expect(vault.error.value).toBeTruthy();
  });

  it("stays locked when the password check fails", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(false);

    await vault.unlock(fakeFile(CONFIG));

    expect(vault.status.value).toBe("locked");
    expect(vault.error.value).toMatch(/incorrect password/i);
  });

  it("serializes concurrent bookmark additions so neither overwrites the other", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(true);
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    // A faithful-enough stand-in for the real addBookmark (bookmarks.ts):
    // read-modify-write off whatever map it's handed.
    let createdAt = 0;
    vi.mocked(bookmarksData.addBookmark).mockImplementation(
      async (_db, _userId, _key, currentMap, txtId, partNum, line, txtPreview) => {
        const next = new Map(currentMap);
        next.set(txtId, [...(next.get(txtId) ?? []), { partNum, line, txtPreview, createdAt: ++createdAt }]);
        return next;
      },
    );

    await vault.unlock(fakeFile(CONFIG));
    expect(vault.status.value).toBe("unlocked");

    // Fired back to back, neither awaited before the other starts -- exactly
    // the "two rapid-fire calls" scenario enqueueMutation exists to handle.
    // Without serializing through it, both would read the same pre-mutation
    // bookmarksMap and one addition would silently overwrite the other.
    await Promise.all([vault.addBookmarkEntry(1, 1, 1, "first"), vault.addBookmarkEntry(1, 1, 2, "second")]);

    expect(vault.bookmarksMap.value.get(1)).toHaveLength(2);
  });

  it("lock() clears the session and returns to locked", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(true);
    vi.mocked(owner.unwrapUmk).mockResolvedValue(new Uint8Array(64).fill(1));
    vi.mocked(owner.fetchR2Config).mockResolvedValue({
      endpoint: "https://x",
      region: "auto",
      bucket: "b",
      readOnlyAccessKeyId: "id",
      readOnlySecretAccessKey: "secret",
    });
    mockLibraryLoads();

    await vault.unlock(fakeFile(CONFIG));
    expect(vault.status.value).toBe("unlocked");

    vault.lock();

    expect(vault.status.value).toBe("locked");
    expect(vault.session.value).toBeNull();
  });
});
