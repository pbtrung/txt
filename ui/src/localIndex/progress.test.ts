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

describe("mountProgressUI", () => {
  it("shows the Skypiea wordmark", () => {
    expect(container.textContent).toContain("Skypiea");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("shows no step counter/label before the first advance()", () => {
    expect(container.textContent).not.toContain("Step");
  });

  it("advance() shows the step counter and that step's label", () => {
    ui.advance("fetching-assets");
    expect(container.textContent).toContain("Step 3 of 5");
    expect(container.textContent).toContain("Fetching assets");
  });

  it("advance() updates the counter/label on each call, not accumulating a list", () => {
    ui.advance("fetching-manifest");
    expect(container.textContent).toContain("Step 1 of 5");
    expect(container.textContent).toContain("Fetching manifest");

    ui.advance("verifying-hashes");
    expect(container.textContent).toContain("Step 4 of 5");
    expect(container.textContent).toContain("Verifying asset hashes");
    expect(container.textContent).not.toContain("Fetching manifest");
  });

  it("fail() stops the spinner and shows the message", () => {
    ui.advance("verifying-signature");
    ui.fail("manifest.json failed its SLH-DSA signature check");

    const spinner = container.querySelector('[role="status"]') as HTMLElement;
    expect(spinner.style.display).toBe("none");
    const error = container.querySelector("p")!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(
      "manifest.json failed its SLH-DSA signature check",
    );
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
