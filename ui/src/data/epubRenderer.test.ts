// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpubRenderer } from "./epubRenderer";

const renditionMock = {
  display: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
};
const bookMock = { renderTo: vi.fn().mockReturnValue(renditionMock), destroy: vi.fn() };
const ePubMock = vi.fn().mockReturnValue(bookMock);

vi.mock("epubjs", () => ({ default: (...args: unknown[]) => ePubMock(...args) }));

afterEach(() => {
  vi.clearAllMocks();
});

describe("EpubRenderer", () => {
  it("opens the book from the given bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    new EpubRenderer(bytes);

    expect(ePubMock).toHaveBeenCalledTimes(1);
    const [arrayBuffer] = ePubMock.mock.calls[0];
    expect(new Uint8Array(arrayBuffer as ArrayBuffer)).toEqual(bytes);
  });

  it("renders into the given element and displays it", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    const element = document.createElement("div");

    renderer.renderTo(element);

    expect(bookMock.renderTo).toHaveBeenCalledWith(element, {
      width: "100%",
      height: "100%",
    });
    expect(renditionMock.display).toHaveBeenCalled();
  });

  it("destroys both the rendition and the book", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.destroy();

    expect(renditionMock.destroy).toHaveBeenCalled();
    expect(bookMock.destroy).toHaveBeenCalled();
  });

  it("destroying before renderTo only destroys the book", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    expect(() => renderer.destroy()).not.toThrow();
    expect(bookMock.destroy).toHaveBeenCalled();
    expect(renditionMock.destroy).not.toHaveBeenCalled();
  });
});
