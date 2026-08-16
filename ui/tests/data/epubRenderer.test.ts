// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpubRenderer } from "../../src/data/epubRenderer";

const TOC = [{ id: "1", href: "ch1.xhtml", label: "Chapter 1" }];

const renditionMock = {
  display: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  next: vi.fn().mockResolvedValue(undefined),
  prev: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  spread: vi.fn(),
  settings: {} as { gap?: number },
  currentLocation: vi.fn().mockReturnValue(undefined),
  themes: { fontSize: vi.fn(), registerCss: vi.fn(), font: vi.fn() },
};
const bookMock = {
  renderTo: vi.fn().mockReturnValue(renditionMock),
  destroy: vi.fn(),
  resolve: vi.fn((href: string) => href),
  loaded: { navigation: Promise.resolve({ toc: TOC }), cover: Promise.resolve("") },
};
const ePubMock = vi.fn().mockReturnValue(bookMock);

vi.mock("@likecoin/epub-ts", () => ({
  default: (...args: unknown[]) => ePubMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  renditionMock.settings = {};
  renditionMock.currentLocation.mockReturnValue(undefined);
  bookMock.loaded.cover = Promise.resolve("");
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
    expect(renditionMock.themes.registerCss).toHaveBeenCalledWith(
      "default",
      expect.stringContaining("@font-face"),
    );
    expect(renditionMock.themes.font).toHaveBeenCalledWith(
      expect.stringContaining("Literata"),
    );
  });

  it("setColumnLayout({columns: 1}) forces a single column", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.setColumnLayout({ columns: 1, gapPx: 0, maxWidthPx: null });

    expect(renditionMock.spread).toHaveBeenCalledWith("none");
  });

  it("setColumnLayout({columns: 2, gapPx}) applies the gap and spreads", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.setColumnLayout({ columns: 2, gapPx: 24, maxWidthPx: null });

    expect(renditionMock.settings.gap).toBe(24);
    expect(renditionMock.spread).toHaveBeenCalledWith("auto", 1);
  });

  function renderedCallback() {
    const call = renditionMock.on.mock.calls.find(([event]) => event === "rendered");
    return call![1] as (section: { href?: string; index?: number }) => void;
  }

  it("forces a single column for an early spine section (front matter)", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    renderer.setColumnLayout({ columns: 2, gapPx: 40, maxWidthPx: 1480 });
    renditionMock.spread.mockClear();

    renderedCallback()({ index: 0, href: "titlepage.xhtml" });

    expect(renditionMock.spread).toHaveBeenCalledWith("none");
  });

  it("applies the preferred 2-column layout for a normal, later section", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    renderer.setColumnLayout({ columns: 2, gapPx: 40, maxWidthPx: 1480 });
    renditionMock.spread.mockClear();

    renderedCallback()({ index: 5, href: "chapter1.xhtml" });

    expect(renditionMock.settings.gap).toBe(40);
    expect(renditionMock.spread).toHaveBeenCalledWith("auto", 1);
  });

  it("forces a single column for the book's own declared cover, however far into the spine it is", async () => {
    bookMock.loaded.cover = Promise.resolve("images/cover.jpg");
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    await bookMock.loaded.cover;
    renderer.setColumnLayout({ columns: 2, gapPx: 40, maxWidthPx: 1480 });
    renditionMock.spread.mockClear();

    renderedCallback()({ index: 10, href: "images/cover.jpg" });

    expect(renditionMock.spread).toHaveBeenCalledWith("none");
  });

  it("setColumnLayout doesn't override the single column while on front matter", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    renderedCallback()({ index: 0, href: "titlepage.xhtml" });
    renditionMock.currentLocation.mockReturnValue({ start: { index: 0 } });
    renditionMock.spread.mockClear();

    renderer.setColumnLayout({ columns: 2, gapPx: 40, maxWidthPx: 1480 });

    expect(renditionMock.spread).not.toHaveBeenCalled();
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
