// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnlockScreen } from "./UnlockScreen";

describe("UnlockScreen", () => {
  it("renders", () => {
    render(<UnlockScreen />);
    expect(screen.getByRole("heading", { name: "Unlock" })).toBeInTheDocument();
  });
});
