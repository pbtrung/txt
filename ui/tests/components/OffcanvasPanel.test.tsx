// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OffcanvasPanel } from "../../src/components/OffcanvasPanel";

describe("OffcanvasPanel", () => {
  it("does not carry the show class when closed", () => {
    render(
      <OffcanvasPanel open={false} onClose={vi.fn()} title="Info">
        content
      </OffcanvasPanel>,
    );
    expect(screen.getByRole("dialog", { name: "Info" })).not.toHaveClass("show");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeNull();
  });

  it("carries the show class and renders a backdrop when open", () => {
    render(
      <OffcanvasPanel open onClose={vi.fn()} title="Info">
        content
      </OffcanvasPanel>,
    );
    expect(screen.getByRole("dialog", { name: "Info" })).toHaveClass("show");
    expect(screen.getByText("content")).toBeInTheDocument();
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
    const { container } = render(
      <OffcanvasPanel open onClose={onClose} title="Info">
        content
      </OffcanvasPanel>,
    );

    await userEvent.click(container.querySelector(".offcanvas-backdrop")!);

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

  it("uses the offcanvas-{breakpoint} class and hides the backdrop past it when responsive", () => {
    const { container } = render(
      <OffcanvasPanel open onClose={vi.fn()} title="Browse" responsive="md">
        content
      </OffcanvasPanel>,
    );

    const panel = screen.getByRole("dialog", { name: "Browse" });
    expect(panel).toHaveClass("offcanvas-md");
    expect(panel).not.toHaveClass("offcanvas offcanvas-end");
    expect(container.querySelector(".offcanvas-backdrop")).toHaveClass("d-md-none");
  });

  it("passes through className and style", () => {
    render(
      <OffcanvasPanel
        open={false}
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
