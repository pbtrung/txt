// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountProgressUI, type ProgressUI } from "./progress";

let container: HTMLElement;
let ui: ProgressUI;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  ui = mountProgressUI(container);
});

afterEach(() => {
  container.remove();
});

function stepText(step: string): string | null {
  return container.querySelector(`li[data-step="${step}"]`)?.textContent ?? null;
}

function stepStatus(step: string): string | undefined {
  return (container.querySelector(`li[data-step="${step}"]`) as HTMLElement | null)?.dataset.status;
}

describe("mountProgressUI", () => {
  it("renders all five steps pending, in order", () => {
    const items = Array.from(container.querySelectorAll("li"));
    expect(items.map((li) => li.dataset.step)).toEqual([
      "fetching-manifest",
      "verifying-signature",
      "fetching-assets",
      "verifying-hashes",
      "loading-application",
    ]);
    expect(stepText("fetching-manifest")).toContain("Fetching manifest");
    expect(stepStatus("fetching-manifest")).toBeUndefined();
  });

  it("advance() marks earlier steps done and the given step active", () => {
    ui.advance("fetching-assets");

    expect(stepStatus("fetching-manifest")).toBe("done");
    expect(stepStatus("verifying-signature")).toBe("done");
    expect(stepStatus("fetching-assets")).toBe("active");
    expect(stepStatus("verifying-hashes")).toBeUndefined();
    expect(stepStatus("loading-application")).toBeUndefined();
  });

  it("fail() marks the current step failed and shows the message", () => {
    ui.advance("verifying-signature");
    ui.fail("manifest.json failed its SLH-DSA signature check");

    expect(stepStatus("verifying-signature")).toBe("failed");
    const error = container.querySelector("p")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("manifest.json failed its SLH-DSA signature check");
  });

  it("fail() before any advance() still shows the error without throwing", () => {
    expect(() => ui.fail("network error")).not.toThrow();
    expect(container.querySelector("p")!.textContent).toBe("network error");
  });

  it("remove() detaches the whole overlay", () => {
    expect(container.querySelector("#boot-status")).not.toBeNull();
    ui.remove();
    expect(container.querySelector("#boot-status")).toBeNull();
  });
});
