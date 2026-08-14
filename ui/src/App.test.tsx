// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the Unlock screen at the root route", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeInTheDocument();
  });
});
