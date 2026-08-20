// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { EpubRenderer } from "../../../src/data/epubRenderer";
import { TocPanel } from "../../../src/screens/Reader/TocPanel";

function fakeRenderer(toc: unknown[], display = vi.fn()): EpubRenderer {
  return {
    getToc: vi.fn().mockResolvedValue(toc),
    display,
  } as unknown as EpubRenderer;
}

describe("TocPanel", () => {
  it("shows an empty state when the book has no contents", async () => {
    render(<TocPanel open onClose={vi.fn()} renderer={fakeRenderer([])} />);

    expect(await screen.findByText("No contents available.")).toBeInTheDocument();
  });

  it("opens from the left and is constrained to the viewport", () => {
    render(<TocPanel open onClose={vi.fn()} renderer={null} />);
    const panel = screen.getByRole("dialog", { name: "Content" });
    expect(panel).toHaveClass("aria-drawer-start", "reader-side-panel");
  });

  it("shows a loading state before the toc resolves", () => {
    render(<TocPanel open onClose={vi.fn()} renderer={null} />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("renders top-level and nested entries once loaded", async () => {
    const onClose = vi.fn();
    const renderer = fakeRenderer([
      {
        id: "1",
        href: "ch1.xhtml",
        label: "Chapter 1",
        subitems: [{ id: "1.1", href: "ch1.xhtml#s1", label: "Section 1.1" }],
      },
    ]);

    render(<TocPanel open onClose={onClose} renderer={renderer} />);

    await waitFor(() => expect(screen.getByText("Chapter 1")).toBeInTheDocument());
    expect(screen.getByText("Section 1.1")).toBeInTheDocument();
    expect(screen.getByRole("treegrid", { name: "Table of contents" })).toBeVisible();
    const chapter = screen.getByRole("row", { name: "Chapter 1" });
    expect(chapter).toHaveAttribute("aria-expanded", "true");

    const chevron = chapter.querySelector("button[slot='chevron']");
    expect(chevron).not.toBeNull();
    await userEvent.click(chevron!);
    expect(chapter).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Section 1.1")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("jumps to the entry's href and closes on click", async () => {
    const display = vi.fn();
    const renderer = fakeRenderer(
      [{ id: "1", href: "ch1.xhtml", label: "Chapter 1" }],
      display,
    );
    const onClose = vi.fn();

    render(<TocPanel open onClose={onClose} renderer={renderer} />);
    await waitFor(() => expect(screen.getByText("Chapter 1")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Chapter 1"));

    expect(display).toHaveBeenCalledWith("ch1.xhtml");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows an error when contents cannot be loaded", async () => {
    const renderer = {
      getToc: vi.fn().mockRejectedValue(new Error("bad navigation")),
    } as unknown as EpubRenderer;

    render(<TocPanel open onClose={vi.fn()} renderer={renderer} />);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Unable to load contents."),
    );
  });
});
