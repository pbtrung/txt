// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
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

  it("shows a checking status instead of Choose File while probing for a session", () => {
    mockVault({ status: "checking-access" });
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking Cloudflare Access session…",
    );
    expect(
      screen.queryByRole("button", { name: "Choose File" }),
    ).not.toBeInTheDocument();
  });

  it("hides Choose File while a session is required, so a picked file can't be lost again", () => {
    mockVault({ status: "access-required" });
    render(
      <MemoryRouter>
        <UnlockScreen />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("button", { name: "Choose File" }),
    ).not.toBeInTheDocument();
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

  it("counts down and redirects to Cloudflare Access when a session is required", () => {
    vi.useFakeTimers();
    const assignMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignMock });
    try {
      mockVault({ status: "access-required" });
      render(
        <MemoryRouter>
          <UnlockScreen />
        </MemoryRouter>,
      );

      expect(screen.getByRole("status")).toHaveTextContent(
        "No Cloudflare Access session found.Redirecting in 3 seconds…",
      );
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Redirecting in 2 seconds…");
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByRole("status")).toHaveTextContent("Redirecting in 1 second…");
      expect(assignMock).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1000));
      expect(assignMock).toHaveBeenCalledWith("/v1/access-check");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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
