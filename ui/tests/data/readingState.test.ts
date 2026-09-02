import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryStore } from "../../src/data/libraryStore";
import { ReadingSession } from "../../src/data/readingState";

function fakeLibrary() {
  const updateReadingPosition = vi.fn().mockResolvedValue(undefined);
  return {
    library: { updateReadingPosition } as unknown as Pick<
      LibraryStore,
      "updateReadingPosition"
    >,
    updateReadingPosition,
  };
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
    const { library, updateReadingPosition } = fakeLibrary();
    const session = new ReadingSession(library, 7);
    session.start("epubcfi(/6/2)", true);

    vi.advanceTimersByTime(5_999);
    expect(updateReadingPosition).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(updateReadingPosition).toHaveBeenCalledOnce();
    expect(updateReadingPosition).toHaveBeenCalledWith(7, "epubcfi(/6/2)", 6_000);
  });

  it("discards a quick open and pauses its grace timer while hidden", () => {
    const quick = fakeLibrary();
    const quickSession = new ReadingSession(quick.library, 7);
    quickSession.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(5_000);
    quickSession.dispose();
    vi.advanceTimersByTime(20_000);
    expect(quick.updateReadingPosition).not.toHaveBeenCalled();

    const paused = fakeLibrary();
    const pausedSession = new ReadingSession(paused.library, 8);
    pausedSession.start("epubcfi(/6/4)", true);
    vi.advanceTimersByTime(3_000);
    pausedSession.setVisible(false);
    vi.advanceTimersByTime(20_000);
    expect(paused.updateReadingPosition).not.toHaveBeenCalled();
    pausedSession.setVisible(true);
    vi.advanceTimersByTime(2_999);
    expect(paused.updateReadingPosition).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(paused.updateReadingPosition).toHaveBeenCalledOnce();
  });

  it("debounces page turns and uploads reading state at most every 15 seconds", () => {
    const { library, updateReadingPosition } = fakeLibrary();
    const session = new ReadingSession(library, 7);
    session.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(6_000);

    vi.advanceTimersByTime(1_000);
    session.relocate("epubcfi(/6/4)", true);
    vi.advanceTimersByTime(1_000);
    session.relocate("epubcfi(/6/6)", true);
    vi.advanceTimersByTime(2_000);
    expect(updateReadingPosition).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_999);
    expect(updateReadingPosition).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);

    expect(updateReadingPosition).toHaveBeenCalledTimes(2);
    expect(updateReadingPosition).toHaveBeenLastCalledWith(7, "epubcfi(/6/6)", null);
  });

  it("flushes a qualified pending position when hidden or disposed", () => {
    const hidden = fakeLibrary();
    const hiddenSession = new ReadingSession(hidden.library, 7);
    hiddenSession.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(6_000);
    hiddenSession.relocate("epubcfi(/6/4)", true);
    hiddenSession.setVisible(false);
    expect(hidden.updateReadingPosition).toHaveBeenCalledTimes(2);

    const disposed = fakeLibrary();
    const disposedSession = new ReadingSession(disposed.library, 8);
    disposedSession.start("epubcfi(/6/2)", true);
    vi.advanceTimersByTime(6_000);
    disposedSession.relocate("epubcfi(/6/8)", true);
    disposedSession.dispose();
    expect(disposed.updateReadingPosition).toHaveBeenCalledTimes(2);
  });

  it("does not dirty the CFI for initial or layout-driven relocations", () => {
    const { library, updateReadingPosition } = fakeLibrary();
    const session = new ReadingSession(library, 7);
    session.start("epubcfi(/6/2)", true);
    session.relocate("epubcfi(/6/3)", false);
    vi.advanceTimersByTime(6_000);
    session.relocate("epubcfi(/6/4)", false);
    session.dispose();

    expect(updateReadingPosition).toHaveBeenCalledOnce();
  });

  it("reports a save failure through onSaveError and re-attempts it on retry()", async () => {
    const updateReadingPosition = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);
    const library = { updateReadingPosition } as unknown as Pick<
      LibraryStore,
      "updateReadingPosition"
    >;
    const session = new ReadingSession(library, 7);
    const errors: unknown[] = [];
    session.onSaveError((error) => errors.push(error));
    session.start("epubcfi(/6/2)", true);

    vi.advanceTimersByTime(6_000);
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    session.retry();
    await vi.waitFor(() => expect(updateReadingPosition).toHaveBeenCalledTimes(2));
  });
});
