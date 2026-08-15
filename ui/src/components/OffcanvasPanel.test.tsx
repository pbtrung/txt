// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OffcanvasPanel } from "./OffcanvasPanel";

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
});
