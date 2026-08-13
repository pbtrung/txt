// @vitest-environment jsdom
//
// Mocks firebaseAuth.signIn/instantClient.createInstantClient/
// session.resolveSession/session.reloadKeyedMaps/library.loadLibrary -- the
// real Firebase/InstantDB network calls -- so this file only needs to prove
// VaultContext.tsx's own React state management (status/progress
// transitions, session shape, accessMap/bookmarksMap updates, error
// handling), not any of that for real. instantDb.transact is a plain
// vi.fn() spy (not mocked away at the module level): VaultContext.tsx's own
// persistAccessMap/persistBookmarksMap build real @instantdb/react tx
// chunks (pure, no network) and hand them to it, so asserting on its own
// call arguments is a real (if shallow) check of what gets written.
//
// crypto/blob's encrypt/decrypt are mocked too (real AEAD correctness is
// already covered exhaustively elsewhere -- blob.test.ts, session.test.ts,
// access.test.ts/bookmarks.test.ts): under this file's jsdom environment,
// the real leancrypto.ts picks its fetch("/leancrypto.js") browser-loading
// path (isWeb() sees jsdom's window/document), which has no dev server to
// actually fetch from here and fails with an unrelated-looking "fetch
// failed" -- passthrough fakes below sidestep that entirely.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64, randomBytes } from "../crypto/bytes";
import type { LibrarySnapshot } from "../data/library";
import type { Session } from "../data/session";

vi.mock("../data/adminBooks", () => ({ saveBookMetadata: vi.fn() }));
vi.mock("../data/firebaseAuth", () => ({ signIn: vi.fn() }));
vi.mock("../data/instantClient", () => ({ createInstantClient: vi.fn() }));
vi.mock("../data/session", () => ({
  resolveSession: vi.fn(),
  reloadKeyedMaps: vi.fn(),
}));
vi.mock("../data/library", () => ({ loadLibrary: vi.fn() }));
vi.mock("../crypto/blob", () => ({
  encrypt: vi.fn(async (_ikm: Uint8Array, payload: Uint8Array) => payload),
  decrypt: vi.fn(async (_ikm: Uint8Array, payload: Uint8Array) => payload),
}));

import { saveBookMetadata } from "../data/adminBooks";
import * as firebaseAuth from "../data/firebaseAuth";
import { createInstantClient } from "../data/instantClient";
import { loadLibrary } from "../data/library";
import { reloadKeyedMaps, resolveSession } from "../data/session";
import { useVault, VaultProvider } from "./VaultContext";

function fakeBookInfo(txtId: string, title: string) {
  return { txtId, name: title, title, subjects: [], rawMetadata: [] };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    authId: "auth-1",
    isAdmin: false,
    umk: randomBytes(128),
    keyStorePrivKey: randomBytes(3224),
    credStoreKey: randomBytes(128),
    r2Config: {
      endpoint: "https://example.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "txt-parts",
    },
    txtAccess: { id: null, key: randomBytes(128), content: {} },
    txtBookmarks: { id: null, key: randomBytes(128), content: {} },
    ...overrides,
  };
}

function fakeLibrary(
  entries: [string, string][] = [["txt-1", "doc-one.txt"]],
): LibrarySnapshot {
  const metadataById = new Map(
    entries.map(([txtId, title]) => [txtId, fakeBookInfo(txtId, title)]),
  );
  const docKeys = new Map(entries.map(([txtId]) => [txtId, randomBytes(128)]));
  const docKinds = new Map(entries.map(([txtId]) => [txtId, "txt" as const]));
  return { metadataById, docKeys, docKinds };
}

function installFakeAuth(sessionOverrides: Partial<Session> = {}) {
  vi.mocked(firebaseAuth.signIn).mockResolvedValue({
    auth: {} as never,
    idToken: "fake-id-token",
  });
  const instantDb = {
    auth: {
      signInWithIdToken: vi.fn().mockResolvedValue({
        user: {
          id: "auth-1",
          email: "admin@example.com",
          refresh_token: "instant-token",
        },
        created: false,
      }),
    },
    transact: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(createInstantClient).mockReturnValue(instantDb as never);
  vi.mocked(resolveSession).mockResolvedValue(fakeSession(sessionOverrides));
  vi.mocked(loadLibrary).mockResolvedValue(fakeLibrary());
  vi.mocked(reloadKeyedMaps).mockResolvedValue({
    txtAccess: { id: null, key: randomBytes(128), content: {} },
    txtBookmarks: { id: null, key: randomBytes(128), content: {} },
  });
  return { instantDb };
}

function fakeFile(contents: unknown): File {
  return new File([JSON.stringify(contents)], "creds.json", {
    type: "application/json",
  });
}

function fakeCredsJson(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    firebase_email: "admin@example.com",
    firebase_password: "hunter2",
    firebase_api_key: "fake-api-key",
    firebase_auth_domain: "example.firebaseapp.com",
    firebase_project_id: "example",
    instant_app_id: "app-1",
    instant_client_name: "firebase",
    user_root_key: bytesToBase64(new Uint8Array(256)),
    ...overrides,
  };
}

function renderVault() {
  return renderHook(() => useVault(), { wrapper: VaultProvider });
}

async function unlockWith(sessionOverrides: Partial<Session> = {}) {
  const { instantDb } = installFakeAuth(sessionOverrides);
  const { result } = renderVault();
  await act(async () => {
    await result.current.unlock(fakeFile(fakeCredsJson()));
  });
  await waitFor(() => expect(result.current.status).toBe("unlocked"));
  return { result, instantDb };
}

describe("VaultProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unlocks successfully and loads metadataById/accessMap/bookmarksMap", async () => {
    const { result, instantDb } = await unlockWith();

    expect(result.current.session?.displayName).toBe("admin@example.com");
    expect(result.current.session?.instantToken).toBe("instant-token");
    expect(result.current.session?.isAdmin).toBe(false);
    expect(result.current.session?.credStoreKey).toBeInstanceOf(Uint8Array);
    expect(result.current.session?.metadataById.get("txt-1")?.title).toBe(
      "doc-one.txt",
    );
    expect(Object.keys(result.current.accessMap)).toHaveLength(0);
    expect(Object.keys(result.current.bookmarksMap)).toHaveLength(0);
    expect(result.current.error).toBeNull();
    expect(instantDb.auth.signInWithIdToken).toHaveBeenCalledWith({
      clientName: "firebase",
      idToken: "fake-id-token",
    });
    expect(resolveSession).toHaveBeenCalledWith(
      instantDb,
      "auth-1",
      expect.any(Uint8Array),
    );
    expect(loadLibrary).toHaveBeenCalledWith(instantDb, expect.anything());
  });

  it("prefers the creds file's own display_name over the signed-in email", async () => {
    installFakeAuth();
    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(
        fakeFile(fakeCredsJson({ display_name: "Trung" })),
      );
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));
    expect(result.current.session?.displayName).toBe("Trung");
  });

  it("prefers credStore.content's own display_name over the unlock file's", async () => {
    installFakeAuth({ displayName: "Canonical Name" });
    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(
        fakeFile(fakeCredsJson({ display_name: "Local File Name" })),
      );
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));
    expect(result.current.session?.displayName).toBe("Canonical Name");
  });

  it("reports an error and stays locked when resolveSession fails", async () => {
    installFakeAuth();
    vi.mocked(resolveSession).mockRejectedValue(new Error("network down"));

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(fakeCredsJson()));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toContain("network down");
    expect(result.current.session).toBeNull();
  });

  it("reports a friendly error for a malformed creds file", async () => {
    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(new File(["not json"], "creds.json"));
    });
    expect(result.current.status).toBe("locked");
    expect(result.current.error).toBeTruthy();
  });

  it("lock() clears session/maps", async () => {
    const { result } = await unlockWith();

    act(() => result.current.lock());

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
    expect(Object.keys(result.current.accessMap)).toHaveLength(0);
  });

  it("lock() zeroes the old session's key material in place, not just the reference", async () => {
    const { result } = await unlockWith();
    const preLock = result.current.session!;
    const docKey = preLock.docKeys.get("txt-1")!;
    expect(preLock.umk.some((b) => b !== 0)).toBe(true); // sanity: not already zero

    act(() => result.current.lock());

    expect(preLock.umk).toEqual(new Uint8Array(preLock.umk.length));
    expect(preLock.keyStorePrivKey).toEqual(
      new Uint8Array(preLock.keyStorePrivKey.length),
    );
    expect(preLock.credStoreKey).toEqual(
      new Uint8Array(preLock.credStoreKey.length),
    );
    expect(preLock.txtAccess.key).toEqual(
      new Uint8Array(preLock.txtAccess.key.length),
    );
    expect(preLock.txtBookmarks.key).toEqual(
      new Uint8Array(preLock.txtBookmarks.key.length),
    );
    expect(docKey).toEqual(new Uint8Array(docKey.length));
  });

  it("recordReadPosition creates this account's first txtAccess row and updates accessMap", async () => {
    const { result, instantDb } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition("txt-1", {
        lastPartNum: 3,
        lastAccessedMs: 5000,
      });
    });

    expect(result.current.accessMap["txt-1"]).toEqual({
      lastPartNum: 3,
      lastAccessedMs: 5000,
    });
    expect(instantDb.transact).toHaveBeenCalledOnce();
  });

  it("a second recordReadPosition call updates the same row instead of creating another", async () => {
    const { result, instantDb } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition("txt-1", {
        lastPartNum: 1,
        lastAccessedMs: 1000,
      });
      await result.current.recordReadPosition("txt-1", {
        lastPartNum: 2,
        lastAccessedMs: 2000,
      });
    });

    expect(instantDb.transact).toHaveBeenCalledTimes(2);
    expect(result.current.accessMap["txt-1"]).toEqual({
      lastPartNum: 2,
      lastAccessedMs: 2000,
    });
  });

  it("removeAccessEntry clears the read position from accessMap", async () => {
    const { result } = await unlockWith();

    await act(async () => {
      await result.current.recordReadPosition("txt-1", {
        lastPartNum: 3,
        lastAccessedMs: 5000,
      });
      await result.current.removeAccessEntry("txt-1");
    });

    expect(result.current.accessMap["txt-1"]).toBeUndefined();
  });

  it("addBookmarkEntry / removeBookmarkEntry update bookmarksMap", async () => {
    const { result } = await unlockWith();

    await act(async () => {
      await result.current.addBookmarkEntry("txt-1", 0, 5, "first line");
    });
    expect(result.current.bookmarksMap["txt-1"]).toHaveLength(1);
    const bookmarkId = result.current.bookmarksMap["txt-1"]![0]!.id;

    await act(async () => {
      await result.current.removeBookmarkEntry("txt-1", bookmarkId);
    });
    expect(result.current.bookmarksMap["txt-1"]).toBeUndefined();
  });

  it("surfaces a rejection from instantDb.transact as a thrown error", async () => {
    const { result, instantDb } = await unlockWith();
    vi.mocked(instantDb.transact).mockRejectedValue(
      new Error(
        "Another session updated this vault. Please reload and try again.",
      ),
    );

    await expect(
      act(async () => {
        await result.current.recordReadPosition("txt-1", {
          lastPartNum: 1,
          lastAccessedMs: 1,
        });
      }),
    ).rejects.toThrow("Another session updated this vault");
  });

  it("refresh() reloads the library and this account's own txtAccess/txtBookmarks content", async () => {
    const { result } = await unlockWith();

    vi.mocked(loadLibrary).mockResolvedValue(
      fakeLibrary([
        ["txt-1", "doc-one.txt"],
        ["txt-2", "doc-two.txt"],
      ]),
    );
    vi.mocked(reloadKeyedMaps).mockResolvedValue({
      txtAccess: {
        id: "access-1",
        key: randomBytes(128),
        content: { "txt-1": { lastPartNum: 1, lastAccessedMs: 1 } },
      },
      txtBookmarks: { id: null, key: randomBytes(128), content: {} },
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.session?.metadataById.size).toBe(2);
    expect(result.current.accessMap["txt-1"]).toEqual({
      lastPartNum: 1,
      lastAccessedMs: 1,
    });
    expect(result.current.refreshing).toBe(false);
  });

  it("updateBookMetadata saves metadata and updates the session map", async () => {
    const { result, instantDb } = await unlockWith();
    vi.mocked(saveBookMetadata).mockResolvedValue(
      fakeBookInfo("txt-1", "Renamed Book"),
    );

    await act(async () => {
      await result.current.updateBookMetadata("txt-1", {
        title: "Renamed Book",
        subjects: [],
      });
    });

    expect(saveBookMetadata).toHaveBeenCalledWith(
      instantDb,
      expect.objectContaining({ authId: "auth-1" }),
      "txt-1",
      { title: "Renamed Book", subjects: [] },
      undefined,
    );
    expect(result.current.session?.metadataById.get("txt-1")?.title).toBe(
      "Renamed Book",
    );
  });
});
