// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReaderScreen } from "./ReaderScreen";

describe("ReaderScreen", () => {
  it("renders", () => {
    render(<ReaderScreen />);
    expect(screen.getByRole("heading", { name: "Reader" })).toBeInTheDocument();
  });
});
