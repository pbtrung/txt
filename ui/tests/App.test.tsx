// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

vi.mock("../src/screens/Reader/SharedReaderScreen", () => ({
  SharedReaderScreen: () => <h1>Shared reader</h1>,
}));

afterEach(() => {
  window.history.pushState(null, "", "/");
});

describe("App", () => {
  it("renders the Unlock screen at the root route", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
  });

  it("redirects /library back to Unlock when locked", () => {
    window.history.pushState(null, "", "/library");
    render(<App />);
    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
  });

  it("redirects /read/:txtId back to Unlock when locked", () => {
    window.history.pushState(null, "", "/read/1");
    render(<App />);
    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
  });

  it("opens /shared without an unlocked account", () => {
    window.history.pushState(null, "", "/shared#id=opaque");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Shared reader" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose File" })).toBeNull();
  });

  it("redirects an unknown route back to Unlock", () => {
    window.history.pushState(null, "", "/nonexistent");
    render(<App />);
    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
  });
});
