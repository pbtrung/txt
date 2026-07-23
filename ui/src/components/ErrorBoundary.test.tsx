// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
  });

  it("shows the error message and a close button when a child throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();

    consoleError.mockRestore();
  });

  it("renders the fallback as a full-viewport overlay, not an inline banner", () => {
    // A known React reconciler edge case can leave the previous screen's
    // real DOM behind, still visible and clickable, even once React's own
    // tree has moved past it -- the fallback has to visually and
    // interactively cover the whole viewport rather than sit inline, or
    // that stale content would still be there underneath it.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const overlay = container.firstElementChild as HTMLElement;
    expect(overlay.className).toContain("position-fixed");
    expect(overlay.className).toContain("w-100");
    expect(overlay.className).toContain("h-100");
    expect(screen.getByRole("alert")).toHaveTextContent(/unlock your library again/i);

    consoleError.mockRestore();
  });

  it("dismissing clears the error and re-renders children fresh", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function MaybeBoom() {
      if (shouldThrow) throw new Error("boom");
      return <div>recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow = false;
    screen.getByRole("button", { name: "Close" }).click();
    rerender(
      <ErrorBoundary>
        <MaybeBoom />
      </ErrorBoundary>,
    );

    expect(screen.getByText("recovered")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    consoleError.mockRestore();
  });
});
