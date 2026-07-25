// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders as a labeled dialog with its content", () => {
    render(
      <Modal title="Create user" onClose={vi.fn()}>
        <p>form goes here</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Create user" })).toBeInTheDocument();
    expect(screen.getByText("form goes here")).toBeInTheDocument();
  });

  it("calls onClose when the close (x) button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Create user" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the backdrop is clicked", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="Create user" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    await userEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose when clicking inside the dialog itself", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Create user" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    await userEvent.click(screen.getByText("content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Create user" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
