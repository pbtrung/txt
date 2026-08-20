// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DrawerPanel } from "../../src/components/DrawerPanel";

describe("DrawerPanel", () => {
  it("does not render a closed drawer", () => {
    render(
      <DrawerPanel open={false} onClose={vi.fn()} title="Info">
        content
      </DrawerPanel>,
    );
    expect(screen.queryByRole("dialog", { name: "Info" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("renders a drawer and backdrop when open", () => {
    render(
      <DrawerPanel open onClose={vi.fn()} title="Info">
        content
      </DrawerPanel>,
    );
    expect(screen.getByRole("dialog", { name: "Info" })).toHaveClass(
      "aria-drawer-panel",
    );
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Info" })).toContainElement(
      document.activeElement as HTMLElement,
    );
  });

  it("calls onClose from the close button", async () => {
    const onClose = vi.fn();
    render(
      <DrawerPanel open onClose={onClose} title="Info">
        content
      </DrawerPanel>,
    );

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveClass("compact-x-button");
    await userEvent.click(close);

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose from the backdrop", async () => {
    const onClose = vi.fn();
    render(
      <DrawerPanel open onClose={onClose} title="Info">
        content
      </DrawerPanel>,
    );

    await userEvent.click(document.querySelector(".aria-drawer-overlay")!);

    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <DrawerPanel open onClose={onClose} title="Info">
        content
      </DrawerPanel>,
    );

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });

  it("passes through className and style", () => {
    render(
      <DrawerPanel
        open
        onClose={vi.fn()}
        title="Info"
        className="border-end"
        style={{ width: "18rem" }}
      >
        content
      </DrawerPanel>,
    );

    const panel = screen.getByRole("dialog", { name: "Info" });
    expect(panel).toHaveClass("border-end");
    expect(panel).toHaveStyle({ width: "288px" }); // jsdom resolves 18rem -> 288px (16px root)
  });

  it("renders the overlay inside an explicit portal container", () => {
    const portalContainer = document.createElement("div");
    document.body.append(portalContainer);
    const { unmount } = render(
      <DrawerPanel
        open
        onClose={vi.fn()}
        title="Info"
        overlayClassName="reader-drawer-overlay"
        portalContainer={portalContainer}
      >
        content
      </DrawerPanel>,
    );

    const overlay = portalContainer.querySelector(".aria-drawer-overlay");
    expect(overlay).toHaveClass("reader-drawer-overlay");
    expect(overlay).toContainElement(screen.getByRole("dialog", { name: "Info" }));
    unmount();
    portalContainer.remove();
  });
});
