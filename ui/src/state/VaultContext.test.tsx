// @vitest-environment jsdom
// Mocks at the data-hook boundary (signIn/fetchDbToken/session/
// libraryIndex/bundle), matching this project's stated testing philosophy
// -- those modules already have their own real-crypto tests; this only
// tests VaultContext's own sequencing/error handling.
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/firebaseSignIn", () => ({ signIn: vi.fn() }));
vi.mock("../data/workerClient", () => ({ fetchDbToken: vi.fn() }));
vi.mock("../data/session", () => ({ readUmk: vi.fn(), readDbPrefix: vi.fn(), readCredStore: vi.fn() }));
vi.mock("../data/libraryIndex", () => ({ loadLibraryIndex: vi.fn() }));
vi.mock("../data/bundle", () => ({ loadBundle: vi.fn() }));

import { signIn } from "../auth/firebaseSignIn";
import { loadBundle } from "../data/bundle";
import { loadLibraryIndex } from "../data/libraryIndex";
import { readCredStore, readDbPrefix, readUmk } from "../data/session";
import { fetchDbToken } from "../data/workerClient";
import { useVault, VaultProvider } from "./VaultContext";

const VALID_CREDS = {
  firebase_email: "a@example.com",
  firebase_password: "pw",
  firebase_api_key: "key",
  user_root_key: btoa("x".repeat(256)),
  r2_config: {
    endpoint: "https://example.r2.cloudflarestorage.com",
    read_only_access_key_id: "a",
    read_only_secret_access_key: "b",
    region: "auto",
    bucket: "bucket",
  },
};

function fakeFile(content: object): File {
  return new File([JSON.stringify(content)], "creds.json", { type: "application/json" });
}

function mockHappyPath() {
  vi.mocked(signIn).mockResolvedValue({ idToken: "tok", uid: "uid-1" });
  vi.mocked(fetchDbToken).mockResolvedValue({ dbToken: "dbtok", dbUrl: "libsql://x" });
  vi.mocked(readUmk).mockResolvedValue(new Uint8Array([1]));
  vi.mocked(readDbPrefix).mockResolvedValue("prefix123");
  vi.mocked(readCredStore).mockResolvedValue({
    user_id: "uid-1",
    display_name: "Ada",
    db_master_key: "b64",
    db_prefix: "prefix123",
  });
  vi.mocked(loadLibraryIndex).mockResolvedValue(new Uint8Array([2]));
  vi.mocked(loadBundle).mockResolvedValue(new Uint8Array([3]));
}

beforeEach(() => vi.clearAllMocks());

describe("VaultContext", () => {
  it("unlocks: signs in, fetches a db token, unwraps umk, loads library+bundle", async () => {
    mockHappyPath();
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    await act(async () => {
      await result.current.unlock(fakeFile(VALID_CREDS));
    });

    expect(result.current.status).toBe("unlocked");
    expect(result.current.session?.dbPrefix).toBe("prefix123");
    expect(result.current.session?.libraryIndexBytes).toEqual(new Uint8Array([2]));
    expect(result.current.session?.bundleBytes).toEqual(new Uint8Array([3]));
    expect(result.current.error).toBeNull();
  });

  it("sets an error and stays locked when umk can't be unwrapped", async () => {
    vi.mocked(signIn).mockResolvedValue({ idToken: "tok", uid: "uid-1" });
    vi.mocked(fetchDbToken).mockResolvedValue({ dbToken: "dbtok", dbUrl: "libsql://x" });
    vi.mocked(readUmk).mockResolvedValue(null);
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    await act(async () => {
      await result.current.unlock(fakeFile(VALID_CREDS));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toMatch(/not initialized/);
  });

  it("rejects a creds.json missing required fields before ever calling signIn", async () => {
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    await act(async () => {
      await result.current.unlock(fakeFile({ firebase_email: "a@example.com" }));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toMatch(/missing/);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("lock() clears the session and returns to locked", async () => {
    mockHappyPath();
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });
    await act(async () => {
      await result.current.unlock(fakeFile(VALID_CREDS));
    });
    expect(result.current.status).toBe("unlocked");

    act(() => result.current.lock());

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
  });
});
