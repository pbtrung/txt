// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LibraryScreen } from "./LibraryScreen";

describe("LibraryScreen", () => {
  it("renders", () => {
    render(<LibraryScreen />);
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
  });
});
