// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./verify", () => ({ verifyAssets: vi.fn() }));
vi.mock("./render", () => ({ renderApp: vi.fn() }));

import { boot } from "./boot";
import { renderApp } from "./render";
import { verifyAssets } from "./verify";

const ASSET_BASE_URL = "https://cdn.example.com/app";
const PUBLIC_KEY_B64 = btoa("x".repeat(64));

beforeEach(() => {
  // renderApp is mocked (doesn't itself touch #root), so pre-populate it --
  // boot()'s waitForRootMount otherwise waits forever for a mutation no
  // mock ever produces.
  document.body.innerHTML = '<div id="root"><span>mounted</span></div>';
  // verbose logging defaults to on (see src/log.ts) -- silence it rather
  // than let it clutter every test run's output.
  vi.spyOn(console, "log").mockImplementation(() => {});
  // jsdom's own crossOriginIsolated is always undefined (it doesn't model
  // cross-origin isolation at all) -- default every test to the real-app
  // case (isolated) unless a test explicitly opts into the fallback below.
  Object.defineProperty(window, "crossOriginIsolated", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.resetAllMocks();
  document.body.innerHTML = "";
});

describe("boot", () => {
  it("verifies then renders, reporting progress and removing the overlay on success", async () => {
    const verified = new Map<string, Uint8Array>([
      ["index.html", new Uint8Array()],
    ]);
    vi.mocked(verifyAssets).mockImplementation(
      async (assetBaseUrl, publicKey, onProgress) => {
        expect(assetBaseUrl).toBe(ASSET_BASE_URL);
        expect(Array.from(publicKey)).toEqual(
          Array.from(new TextEncoder().encode("x".repeat(64))),
        );
        onProgress("fetching-manifest");
        onProgress("verifying-hashes");
        return verified;
      },
    );

    await boot(ASSET_BASE_URL, PUBLIC_KEY_B64);

    expect(verifyAssets).toHaveBeenCalledTimes(1);
    expect(renderApp).toHaveBeenCalledWith(ASSET_BASE_URL, verified);
    expect(document.getElementById("boot-status")).toBeNull();
  });

  it("shows the failure and never renders when verification fails", async () => {
    vi.mocked(verifyAssets).mockRejectedValue(
      new Error("manifest.json failed its SLH-DSA signature check"),
    );

    await boot(ASSET_BASE_URL, PUBLIC_KEY_B64);

    expect(renderApp).not.toHaveBeenCalled();
    const status = document.getElementById("boot-status")!;
    expect(status).not.toBeNull();
    expect(status.querySelector("p")!.textContent).toBe(
      "manifest.json failed its SLH-DSA signature check",
    );
  });

  it("shows the failure when rendering itself throws", async () => {
    vi.mocked(verifyAssets).mockResolvedValue(new Map());
    vi.mocked(renderApp).mockImplementation(() => {
      throw new Error("manifest.json didn't include index.html");
    });

    await boot(ASSET_BASE_URL, PUBLIC_KEY_B64);

    const status = document.getElementById("boot-status")!;
    expect(status.querySelector("p")!.textContent).toBe(
      "manifest.json didn't include index.html",
    );
  });

  it("shows the verified-fallback message and never renders when not cross-origin isolated", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      value: false,
      configurable: true,
    });
    const verified = new Map<string, Uint8Array>([
      ["index.html", new Uint8Array()],
    ]);
    vi.mocked(verifyAssets).mockResolvedValue(verified);

    await boot(ASSET_BASE_URL, PUBLIC_KEY_B64);

    expect(renderApp).not.toHaveBeenCalled();
    const status = document.getElementById("boot-status")!;
    expect(status).not.toBeNull(); // overlay stays -- this is a terminal state, not remove()'d
    const link = status.querySelector("a")!;
    expect(link.href).toBe(ASSET_BASE_URL);
    expect(link.target).toBe("_blank");
  });
});
