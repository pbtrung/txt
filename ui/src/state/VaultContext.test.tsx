// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useVault, VaultProvider } from "./VaultContext";

vi.mock("../data/db", () => ({ createDb: vi.fn(() => ({ execute: vi.fn() })) }));
vi.mock("../data/r2", () => ({ createR2Client: vi.fn(() => ({ fetch: vi.fn() })) }));
vi.mock("../data/owner", () => ({
  resolveUserId: vi.fn(),
  checkPassword: vi.fn(),
  unwrapUmk: vi.fn(),
  unwrapTxtKey: vi.fn(),
  fetchR2Config: vi.fn(),
}));

import * as owner from "../data/owner";

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

function renderVault() {
  return renderHook(() => useVault(), { wrapper: VaultProvider });
}

describe("VaultProvider", () => {
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

    const { result } = renderVault();
    expect(result.current.status).toBe("locked");

    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });

    await waitFor(() => expect(result.current.status).toBe("unlocked"));
    expect(result.current.session?.userId).toBe(42);
    expect(result.current.session?.creds.displayName).toBe("Alice");
    expect(result.current.error).toBeNull();
  });

  it("stays locked and reports an error for an invalid config file", async () => {
    const { result } = renderVault();

    await act(async () => {
      await result.current.unlock(fakeFile({ not: "a valid config" }));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
    expect(result.current.error).toBeTruthy();
  });

  it("stays locked when the password check fails", async () => {
    vi.mocked(owner.resolveUserId).mockResolvedValue(42);
    vi.mocked(owner.checkPassword).mockResolvedValue(false);

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });

    expect(result.current.status).toBe("locked");
    expect(result.current.error).toMatch(/incorrect password/i);
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

    const { result } = renderVault();
    await act(async () => {
      await result.current.unlock(fakeFile(CONFIG));
    });
    await waitFor(() => expect(result.current.status).toBe("unlocked"));

    act(() => result.current.lock());

    expect(result.current.status).toBe("locked");
    expect(result.current.session).toBeNull();
  });
});
