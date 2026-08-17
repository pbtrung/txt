// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EpubRenderer } from "../../../src/data/epubRenderer";
import { BookmarksPanel } from "../../../src/screens/Reader/BookmarksPanel";

afterEach(cleanup);

describe("BookmarksPanel", () => {
  it("navigates to and deletes saved CFIs", async () => {
    const display = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const remove = vi.fn();
    render(
      <BookmarksPanel
        open
        onClose={close}
        renderer={{ display } as unknown as EpubRenderer}
        bookmarks={[
          {
            id: 1,
            cfi: "epubcfi(/6/4)",
            preview: "Fear is the mind-killer.",
            createdAt: 42,
          },
        ]}
        busy={false}
        status={{ pending: false, unsaved: false, error: null }}
        error={null}
        onRemove={remove}
        onRetry={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText("Fear is the mind-killer."));
    expect(display).toHaveBeenCalledWith("epubcfi(/6/4)");
    expect(close).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "Delete bookmark" }));
    expect(remove).toHaveBeenCalledWith("epubcfi(/6/4)");
  });

  it("shows retained write errors and retries them", async () => {
    const retry = vi.fn();
    render(
      <BookmarksPanel
        open
        onClose={vi.fn()}
        renderer={null}
        bookmarks={[]}
        busy={false}
        status={{ pending: false, unsaved: true, error: "conflict" }}
        error="conflict"
        onRemove={vi.fn()}
        onRetry={retry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Bookmarks have unsaved changes: conflict",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
