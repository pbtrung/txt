// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpubRenderer } from "./epubRenderer";

const TOC = [{ id: "1", href: "ch1.xhtml", label: "Chapter 1" }];

const renditionMock = {
  display: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  next: vi.fn().mockResolvedValue(undefined),
  prev: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  themes: { fontSize: vi.fn() },
};
const bookMock = {
  renderTo: vi.fn().mockReturnValue(renditionMock),
  destroy: vi.fn(),
  loaded: { navigation: Promise.resolve({ toc: TOC }) },
};
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
      allowScriptedContent: true,
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

  it("display() jumps to an arbitrary TOC href or CFI", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    renditionMock.display.mockClear();

    await renderer.display("chapter1.xhtml");

    expect(renditionMock.display).toHaveBeenCalledWith("chapter1.xhtml");
  });

  it("next()/prev() delegate to the rendition", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    await renderer.next();
    await renderer.prev();

    expect(renditionMock.next).toHaveBeenCalledTimes(1);
    expect(renditionMock.prev).toHaveBeenCalledTimes(1);
  });

  it("onKeyup() subscribes to the rendition's relayed keyup event", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    const cb = vi.fn();

    renderer.onKeyup(cb);

    expect(renditionMock.on).toHaveBeenCalledWith("keyup", cb);
  });

  it("setFontSize() delegates to the rendition's themes", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.setFontSize("120%");

    expect(renditionMock.themes.fontSize).toHaveBeenCalledWith("120%");
  });

  it("getToc() resolves the book's navigation without needing renderTo() first", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));

    expect(await renderer.getToc()).toEqual(TOC);
  });

  it("throws a clear error when a rendition method is called before renderTo()", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));

    await expect(renderer.next()).rejects.toThrow(/renderTo\(\)/);
    expect(() => renderer.setFontSize("100%")).toThrow(/renderTo\(\)/);
  });
});
