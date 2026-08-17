import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DatabaseMutation,
  LibraryDatabaseStore,
} from "../../src/data/databaseStore";
import {
  deleteBookmarkMutation,
  listBookmarks,
  ReadingSession,
  saveBookmarkMutation,
  truncateUtf8,
} from "../../src/data/readingState";
import type { SqliteDatabase } from "../../src/data/sqlite";

function fakeDatabase() {
  const execute = vi.fn();
  const mutate = vi.fn(async (mutation: DatabaseMutation) => {
    mutation.apply({ execute } as unknown as SqliteDatabase);
  });
  return { database: { mutate }, mutate, execute };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ReadingSession", () => {
  it("records last access and the stable CFI only after six visible seconds", () => {
    const { database, mutate, execute } = fakeDatabase();
    const session = new ReadingSession(database, 7);
    session.start("epubcfi(/6/2)", true);

    vi.advanceTimersByTime(5_999);
    expect(mutate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(mutate).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      "UPDATE txt SET last_accessed = ?, last_cfi = ? WHERE id = ?",
      [6_000, "epubcfi(/6/2)", 7],
    );
  });

  it("discards a quick open and pauses its grace timer while hidden", () => {
    const quick = fakeDatabase();
    const quickSession = new ReadingSession(quick.database, 7);
    quickSession.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(5_000);
    quickSession.dispose();
    vi.advanceTimersByTime(20_000);
    expect(quick.mutate).not.toHaveBeenCalled();

    const paused = fakeDatabase();
    const pausedSession = new ReadingSession(paused.database, 8);
    pausedSession.start("epubcfi(/6/4)", true);
    vi.advanceTimersByTime(3_000);
    pausedSession.setVisible(false);
    vi.advanceTimersByTime(20_000);
    expect(paused.mutate).not.toHaveBeenCalled();
    pausedSession.setVisible(true);
    vi.advanceTimersByTime(2_999);
    expect(paused.mutate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(paused.mutate).toHaveBeenCalledOnce();
  });

  it("debounces page turns and uploads reading state at most every 15 seconds", () => {
    const { database, mutate, execute } = fakeDatabase();
    const session = new ReadingSession(database, 7);
    session.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(6_000);

    vi.advanceTimersByTime(1_000);
    session.relocate("epubcfi(/6/4)", true);
    vi.advanceTimersByTime(1_000);
    session.relocate("epubcfi(/6/6)", true);
    vi.advanceTimersByTime(2_000);
    expect(mutate).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_999);
    expect(mutate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      "UPDATE txt SET last_cfi = ? WHERE id = ?",
      ["epubcfi(/6/6)", 7],
    );
  });

  it("flushes a qualified pending position when hidden or disposed", () => {
    const hidden = fakeDatabase();
    const hiddenSession = new ReadingSession(hidden.database, 7);
    hiddenSession.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(6_000);
    hiddenSession.relocate("epubcfi(/6/4)", true);
    hiddenSession.setVisible(false);
    expect(hidden.mutate).toHaveBeenCalledTimes(2);

    const disposed = fakeDatabase();
    const disposedSession = new ReadingSession(disposed.database, 8);
    disposedSession.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(6_000);
    disposedSession.relocate("epubcfi(/6/8)", true);
    disposedSession.dispose();
    expect(disposed.mutate).toHaveBeenCalledTimes(2);
  });

  it("does not dirty the CFI for initial or layout-driven relocations", () => {
    const { database, mutate } = fakeDatabase();
    const session = new ReadingSession(database, 7);
    session.start("epubcfi(/6/2)", true);
    session.relocate("epubcfi(/6/3)", false);
    vi.advanceTimersByTime(6_000);
    session.relocate("epubcfi(/6/4)", false);
    session.dispose();

    expect(mutate).toHaveBeenCalledOnce();
  });
});

describe("bookmark mutations", () => {
  it("normalizes and truncates previews to 100 UTF-8 bytes", () => {
    const execute = vi.fn();
    saveBookmarkMutation(3, "epubcfi(/6/2)", `  ${"é".repeat(60)}   tail  `, 42).apply({
      execute,
    } as unknown as SqliteDatabase);

    const preview = execute.mock.calls[0][1][2] as string;
    expect(new TextEncoder().encode(preview)).toHaveLength(100);
    expect(preview).toBe("é".repeat(50));
    expect(truncateUtf8("abc", 2)).toBe("ab");
  });

  it("loads newest bookmarks and deletes by document and CFI", async () => {
    const query = vi.fn().mockReturnValue([
      [2, "epubcfi(/6/4)", "Second", 20],
      [1, "epubcfi(/6/2)", "First", 10],
    ]);
    const database = {
      read: async (reader: (db: unknown) => unknown) => reader({ query }),
    } as unknown as LibraryDatabaseStore;

    await expect(listBookmarks(database, 3)).resolves.toEqual([
      { id: 2, cfi: "epubcfi(/6/4)", preview: "Second", createdAt: 20 },
      { id: 1, cfi: "epubcfi(/6/2)", preview: "First", createdAt: 10 },
    ]);

    const execute = vi.fn();
    deleteBookmarkMutation(3, "epubcfi(/6/4)").apply({
      execute,
    } as unknown as SqliteDatabase);
    expect(execute).toHaveBeenCalledWith(
      "DELETE FROM txt_bookmarks WHERE txt_id = ? AND cfi = ?",
      [3, "epubcfi(/6/4)"],
    );
  });
});
