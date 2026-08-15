// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App";

afterEach(() => {
  window.history.pushState(null, "", "/");
});

describe("App", () => {
  it("renders the Unlock screen at the root route", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /Unlock/ })).toBeInTheDocument();
  });

  it("redirects /library back to Unlock when locked", () => {
    window.history.pushState(null, "", "/library");
    render(<App />);
    expect(screen.getByRole("heading", { name: /Unlock/ })).toBeInTheDocument();
  });

  it("redirects /read/:txtId back to Unlock when locked", () => {
    window.history.pushState(null, "", "/read/1");
    render(<App />);
    expect(screen.getByRole("heading", { name: /Unlock/ })).toBeInTheDocument();
  });

  it("redirects an unknown route back to Unlock", () => {
    window.history.pushState(null, "", "/nonexistent");
    render(<App />);
    expect(screen.getByRole("heading", { name: /Unlock/ })).toBeInTheDocument();
  });
});
