// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/state/VaultContext", () => ({ useVault: vi.fn() }));

import { useVault } from "../../../src/state/VaultContext";
import { UnlockScreen } from "../../../src/screens/Unlock/UnlockScreen";

function mockVault(overrides: Partial<ReturnType<typeof useVault>>) {
  vi.mocked(useVault).mockReturnValue({
    status: "locked",
    session: null,
    error: null,
    progress: null,
    unlock: vi.fn(),
    lock: vi.fn(),
    ...overrides,
  });
}

describe("UnlockScreen", () => {
  it("renders a Choose File button when locked", () => {
    mockVault({});
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
  });

  it("calls unlock() with the chosen file", async () => {
    const unlock = vi.fn().mockResolvedValue(undefined);
    mockVault({ unlock });
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );

    const file = new File([JSON.stringify({})], "creds.json", {
      type: "application/json",
    });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);

    expect(unlock).toHaveBeenCalledWith(file);
  });

  it("shows the progress label while unlocking", () => {
    mockVault({
      status: "unlocking",
      progress: { label: "Signing in", step: 2, total: 5 },
    });
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Signing in (step 2 of 5)");
  });

  it("shows an error message", () => {
    mockVault({ error: "could not fetch owner record: 500" });
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "could not fetch owner record: 500",
    );
  });

  it("offers a Cloudflare Access login link when a session is required", async () => {
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });
    mockVault({ status: "access-required" });
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );

    const button = screen.getByRole("button", {
      name: "Log in with Cloudflare Access",
    });
    await userEvent.click(button);
    expect(assignMock).toHaveBeenCalledWith("/v1/access-check");
    vi.unstubAllGlobals();
  });

  it("navigates to /library once unlocked", () => {
    mockVault({ status: "unlocked" });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<UnlockScreen />} />
          <Route path="/library" element={<div>Library Screen</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Library Screen")).toBeInTheDocument();
  });
});
