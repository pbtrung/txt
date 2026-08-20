// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpubRenderer } from "../../../src/data/epubRenderer";
import { BookmarkMenu } from "../../../src/screens/Reader/ReaderNavigation";

afterEach(cleanup);

describe("BookmarkMenu", () => {
  it("navigates to and deletes saved CFIs", async () => {
    const display = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    render(
      <BookmarkMenu
        renderer={{ display } as unknown as EpubRenderer}
        bookmarks={[
          {
            id: 1,
            cfi: "epubcfi(/6/4)",
            pageNumber: 12,
            preview: "Fear is the mind-killer.",
            createdAt: 42,
          },
        ]}
        bookmarkSaved={false}
        bookmarkBusy={false}
        status={{ pending: false, unsaved: false, error: null }}
        error={null}
        onBookmark={vi.fn()}
        onRemove={remove}
        onRetry={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    const dialog = screen.getByRole("dialog", { name: "Bookmark options" });
    expect(dialog.parentElement).toHaveClass("reader-bookmark-menu");
    expect(screen.getByText("Page 12")).toBeInTheDocument();
    expect(screen.getByText("Fear is the mind-killer.")).toHaveClass(
      "w-full",
      "truncate",
    );
    expect(
      screen.getByText("Fear is the mind-killer.").closest('[role="row"]'),
    ).toHaveClass(
      "grid",
      "max-w-full",
      "grid-cols-[minmax(0,1fr)_auto]",
      "overflow-hidden",
    );
    expect(screen.getByRole("grid", { name: "Saved bookmarks" })).toContainElement(
      screen.getByRole("row", { name: /Fear is the mind-killer/ }),
    );

    await userEvent.click(screen.getByText("Fear is the mind-killer."));
    expect(display).toHaveBeenCalledWith("epubcfi(/6/4)");

    await userEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    const removeButton = screen.getByRole("button", { name: "Delete bookmark" });
    expect(removeButton).toHaveClass("btn-square", "compact-delete-button");
    await userEvent.click(removeButton);
    expect(remove).toHaveBeenCalledWith("epubcfi(/6/4)");
  });

  it("shows retained write errors and retries them", async () => {
    const retry = vi.fn();
    render(
      <BookmarkMenu
        renderer={null}
        bookmarks={[]}
        bookmarkSaved={false}
        bookmarkBusy={false}
        status={{ pending: false, unsaved: true, error: "conflict" }}
        error="conflict"
        onBookmark={vi.fn()}
        onRemove={vi.fn()}
        onRetry={retry}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Bookmarks" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Unsaved changes: conflict");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
