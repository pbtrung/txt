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

    expect(
      screen.getByRole("dialog", { name: "Create user" }),
    ).toBeInTheDocument();
    expect(screen.getByText("form goes here")).toBeInTheDocument();
  });

  it("calls onClose from the close button, backdrop, and Escape", async () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="Create user" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(container.firstChild as HTMLElement);
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not call onClose when clicking inside the dialog", async () => {
    const onClose = vi.fn();
    render(
      <Modal title="Create user" onClose={onClose}>
        <p>content</p>
      </Modal>,
    );

    await userEvent.click(screen.getByText("content"));

    expect(onClose).not.toHaveBeenCalled();
  });
});
