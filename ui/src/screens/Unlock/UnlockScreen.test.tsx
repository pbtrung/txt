// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { UnlockScreen } from "./UnlockScreen";
import * as VaultContextModule from "../../state/VaultContext";

vi.mock("../../state/VaultContext", async () => {
  const actual = await vi.importActual<typeof import("../../state/VaultContext")>("../../state/VaultContext");
  return { ...actual, useVault: vi.fn() };
});

function renderUnlock() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<UnlockScreen />} />
        <Route path="/library" element={<div>Library screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Defaults for the parts of VaultContextValue this screen doesn't exercise. */
function baseVaultValue(): VaultContextModule.VaultContextValue {
  return {
    status: "locked",
    session: null,
    error: null,
    accessMap: new Map(),
    bookmarksMap: new Map(),
    refreshing: false,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    refresh: vi.fn(),
    getTxtKey: vi.fn(),
    recordReadPosition: vi.fn(),
    removeAccessEntry: vi.fn(),
    addBookmarkEntry: vi.fn(),
    removeBookmarkEntry: vi.fn(),
  };
}

describe("UnlockScreen", () => {
  it("renders the wordmark and unlock button", () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue(baseVaultValue());
    renderUnlock();
    expect(screen.getByText("Skypiea")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose file/i })).toBeInTheDocument();
  });

  it("calls unlock() with the chosen file", async () => {
    const unlock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(VaultContextModule.useVault).mockReturnValue({ ...baseVaultValue(), unlock });
    renderUnlock();

    const file = new File(["{}"], "config.json", { type: "application/json" });
    const input = screen.getByLabelText(/choose config file/i) as HTMLInputElement;
    await userEvent.upload(input, file);

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock.mock.calls[0][0].name).toBe("config.json");
  });

  it("shows an error message when present", () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({
      ...baseVaultValue(),
      error: "Incorrect password for this account.",
    });
    renderUnlock();
    expect(screen.getByRole("alert")).toHaveTextContent("Incorrect password for this account.");
  });

  it("shows a spinner and status line while unlocking", () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({ ...baseVaultValue(), status: "unlocking" });
    renderUnlock();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/setting up your library/i)).toBeInTheDocument();
  });

  it("shows the current phase and a step counter under the spinner once progress is set", () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({
      ...baseVaultValue(),
      status: "unlocking",
      progress: { label: "Unwrapping your keys", step: 2, total: 3 },
    });
    renderUnlock();
    const step = screen.getByText("Step 2 of 3");
    const label = screen.getByText(/unwrapping your keys/i);
    // Step counter on top, phase label underneath it.
    expect(step.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The generic fallback line is gone once a real phase label takes over.
    expect(screen.queryByText(/setting up your library/i)).not.toBeInTheDocument();
  });

  it("navigates to /library once unlocked", async () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({ ...baseVaultValue(), status: "unlocked" });
    renderUnlock();
    await waitFor(() => expect(screen.getByText("Library screen")).toBeInTheDocument());
  });
});
