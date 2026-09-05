// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { ApiClient, type OwnerRecord } from "../src/data/apiClient";

vi.mock("../src/screens/Reader/SharedReaderScreen", () => ({
  SharedReaderScreen: () => <h1>Shared reader</h1>,
}));

// VaultProvider probes GET /v1/owner on mount (ui/src/state/VaultContext.tsx)
// before these routing tests ever see "locked" -- there's no real Worker to
// answer it here, so stub it to resolve rather than have every render() hang
// in "checking-access" or fall into "access-required" the way a genuine
// fetch failure would.
const ownerFixture: OwnerRecord = {
  wrappedUmk: new Uint8Array(),
  signPublicKey: new Uint8Array(),
  wrappedSignPrivateKey: new Uint8Array(),
  kemPublicKey: new Uint8Array(),
  wrappedKemPrivateKey: new Uint8Array(),
  encryptedCredentials: new Uint8Array(),
  ticket: "test-ticket",
};
vi.spyOn(ApiClient.prototype, "fetchOwner").mockResolvedValue(ownerFixture);

afterEach(() => {
  window.history.pushState(null, "", "/");
});

describe("App", () => {
  it("renders the Unlock screen at the root route", async () => {
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Choose File" }),
    ).toBeInTheDocument();
  });

  it("redirects /library back to Unlock when locked", async () => {
    window.history.pushState(null, "", "/library");
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Choose File" }),
    ).toBeInTheDocument();
  });

  it("redirects /read/:txtId back to Unlock when locked", async () => {
    window.history.pushState(null, "", "/read/1");
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Choose File" }),
    ).toBeInTheDocument();
  });

  it("opens /shared without an unlocked account", () => {
    window.history.pushState(null, "", "/shared#id=opaque");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Shared reader" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose File" })).toBeNull();
  });

  it("redirects an unknown route back to Unlock", async () => {
    window.history.pushState(null, "", "/nonexistent");
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "Choose File" }),
    ).toBeInTheDocument();
  });
});
