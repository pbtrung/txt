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

describe("UnlockScreen", () => {
  it("renders the wordmark and unlock button", () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({
      status: "locked",
      session: null,
      error: null,
      unlock: vi.fn(),
      lock: vi.fn(),
      getTxtKey: vi.fn(),
    });
    renderUnlock();
    expect(screen.getByText("Skypiea")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose file/i })).toBeInTheDocument();
  });

  it("calls unlock() with the chosen file", async () => {
    const unlock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(VaultContextModule.useVault).mockReturnValue({
      status: "locked",
      session: null,
      error: null,
      unlock,
      lock: vi.fn(),
      getTxtKey: vi.fn(),
    });
    renderUnlock();

    const file = new File(["{}"], "config.json", { type: "application/json" });
    const input = screen.getByLabelText(/choose config file/i) as HTMLInputElement;
    await userEvent.upload(input, file);

    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock.mock.calls[0][0].name).toBe("config.json");
  });

  it("shows an error message when present", () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({
      status: "locked",
      session: null,
      error: "Incorrect password for this account.",
      unlock: vi.fn(),
      lock: vi.fn(),
      getTxtKey: vi.fn(),
    });
    renderUnlock();
    expect(screen.getByRole("alert")).toHaveTextContent("Incorrect password for this account.");
  });

  it("navigates to /library once unlocked", async () => {
    vi.mocked(VaultContextModule.useVault).mockReturnValue({
      status: "unlocked",
      session: null,
      error: null,
      unlock: vi.fn(),
      lock: vi.fn(),
      getTxtKey: vi.fn(),
    });
    renderUnlock();
    await waitFor(() => expect(screen.getByText("Library screen")).toBeInTheDocument());
  });
});
