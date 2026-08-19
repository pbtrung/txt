// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OffcanvasPanel } from "../../src/components/OffcanvasPanel";

describe("OffcanvasPanel", () => {
  it("does not render a closed drawer", () => {
    render(
      <OffcanvasPanel open={false} onClose={vi.fn()} title="Info">
        content
      </OffcanvasPanel>,
    );
    expect(screen.queryByRole("dialog", { name: "Info" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("carries the show class and renders a backdrop when open", () => {
    render(
      <OffcanvasPanel open onClose={vi.fn()} title="Info">
        content
      </OffcanvasPanel>,
    );
    expect(screen.getByRole("dialog", { name: "Info" })).toHaveClass("show");
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Info" })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("calls onClose from the close button", async () => {
    const onClose = vi.fn();
    render(
      <OffcanvasPanel open onClose={onClose} title="Info">
        content
      </OffcanvasPanel>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose from the backdrop", async () => {
    const onClose = vi.fn();
    render(
      <OffcanvasPanel open onClose={onClose} title="Info">
        content
      </OffcanvasPanel>,
    );

    await userEvent.click(document.querySelector(".aria-offcanvas-overlay")!);

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <OffcanvasPanel open onClose={onClose} title="Info">
        content
      </OffcanvasPanel>,
    );

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("passes through className and style", () => {
    render(
      <OffcanvasPanel
        open
        onClose={vi.fn()}
        title="Info"
        className="border-end"
        style={{ width: "18rem" }}
      >
        content
      </OffcanvasPanel>,
    );

    const panel = screen.getByRole("dialog", { name: "Info" });
    expect(panel).toHaveClass("border-end");
    expect(panel).toHaveStyle({ width: "288px" }); // jsdom resolves 18rem -> 288px (16px root)
  });
});
