// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpubRenderer } from "../../src/data/epubRenderer";

const TOC = [{ id: "1", href: "ch1.xhtml", label: "Chapter 1" }];

const renditionMock = {
  display: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  next: vi.fn().mockResolvedValue(undefined),
  prev: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn(),
  on: vi.fn(),
  spread: vi.fn(),
  settings: {} as { gap?: number },
  manager: { settings: {} as { gap?: number }, isRendered: vi.fn(() => true) },
  currentLocation: vi.fn().mockReturnValue(undefined),
  getRange: vi.fn().mockReturnValue(null),
  getContents: vi.fn().mockReturnValue([]),
  themes: { fontSize: vi.fn(), registerCss: vi.fn(), font: vi.fn() },
};
const bookMock = {
  opened: Promise.resolve({}),
  renderTo: vi.fn().mockReturnValue(renditionMock),
  destroy: vi.fn(),
  resolve: vi.fn((href: string) => href),
  locations: {
    generate: vi.fn().mockResolvedValue(["epubcfi(/6/2)"]),
    locationFromCfi: vi.fn().mockReturnValue(0),
    cfiFromLocation: vi.fn().mockReturnValue("epubcfi(/6/2)"),
    length: vi.fn().mockReturnValue(1),
  },
  spine: { hooks: { content: { register: vi.fn() } } },
  loaded: { navigation: Promise.resolve({ toc: TOC }), cover: Promise.resolve("") },
};
const ePubMock = vi.fn().mockReturnValue(bookMock);

vi.mock("@likecoin/epub-ts", () => ({
  default: (...args: unknown[]) => ePubMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  renditionMock.settings = {};
  renditionMock.manager.settings = {};
  renditionMock.manager.isRendered.mockReturnValue(true);
  renditionMock.currentLocation.mockReturnValue(undefined);
  renditionMock.getRange.mockReturnValue(null);
  renditionMock.getContents.mockReturnValue([]);
  bookMock.loaded.cover = Promise.resolve("");
  bookMock.opened = Promise.resolve({});
  bookMock.locations.locationFromCfi.mockReturnValue(0);
  bookMock.locations.cfiFromLocation.mockReturnValue("epubcfi(/6/2)");
  bookMock.locations.length.mockReturnValue(1);
  bookMock.locations.generate.mockResolvedValue(["epubcfi(/6/2)"]);
});

describe("EpubRenderer", () => {
  it("opens the book from the given bytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    new EpubRenderer(bytes);

    expect(ePubMock).toHaveBeenCalledTimes(1);
    const [arrayBuffer] = ePubMock.mock.calls[0];
    expect(new Uint8Array(arrayBuffer as ArrayBuffer)).toEqual(bytes);
  });

  it("renders untrusted book content without allowing scripts", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    const element = document.createElement("div");

    await renderer.renderTo(element);

    expect(bookMock.renderTo).toHaveBeenCalledWith(element, {
      width: "100%",
      height: "100%",
      allowScriptedContent: false,
    });
    expect(renditionMock.display).toHaveBeenCalled();
    expect(renditionMock.themes.registerCss).toHaveBeenCalledWith(
      "default",
      expect.stringContaining("@font-face"),
    );
    const themeCss = renditionMock.themes.registerCss.mock.calls[0][1] as string;
    expect(themeCss).toContain("font-family: 'Txt Literata'");
    expect(themeCss).toMatch(/html, body \{\s*margin-inline: 0 !important;/);
    expect(themeCss).toMatch(/html \{\s*padding-inline: 0 !important;/);
    expect(themeCss).toMatch(
      /body, body \* \{\s*font-family: 'Txt Literata', serif !important;/,
    );
    expect(renditionMock.themes.font).toHaveBeenCalledWith("'Txt Literata', serif");
  });

  it("reports initial display failures and prevents duplicate mounts", async () => {
    renditionMock.display.mockRejectedValueOnce(new Error("display failed"));
    const renderer = new EpubRenderer(new Uint8Array([1]));

    await expect(renderer.renderTo(document.createElement("div"))).rejects.toThrow(
      /display failed/,
    );
    await expect(renderer.renderTo(document.createElement("div"))).rejects.toThrow(
      /already mounted/,
    );
  });

  it("resumes at the saved CFI and falls back to the beginning if it is stale", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));

    await renderer.renderTo(document.createElement("div"), "epubcfi(/6/4!/4/2)");

    expect(renditionMock.display).toHaveBeenCalledWith("epubcfi(/6/4!/4/2)");

    renditionMock.display.mockClear();
    renditionMock.display.mockRejectedValueOnce(new Error("invalid CFI"));
    const fallback = new EpubRenderer(new Uint8Array([1]));
    await fallback.renderTo(document.createElement("div"), "epubcfi(stale)");

    expect(renditionMock.display.mock.calls).toEqual([["epubcfi(stale)"], []]);
  });

  function coverHook() {
    return bookMock.spine.hooks.content.register.mock.calls.at(-1)![0] as (
      document: Document,
      section: { href?: string; url?: string },
    ) => Promise<void>;
  }

  it("replaces the declared cover image with the title and authors before render", async () => {
    bookMock.loaded.cover = Promise.resolve("https://reader.test/OEBPS/cover.jpg");
    new EpubRenderer(new Uint8Array([1]), "Dune", ["Frank Herbert"]);
    const cover = document.implementation.createHTMLDocument();
    cover.head.innerHTML = '<base href="https://reader.test/OEBPS/titlepage.xhtml">';
    cover.body.innerHTML = '<img src="cover.jpg" alt="Cover">';

    await coverHook()(cover, { href: "titlepage.xhtml" });

    expect(cover.body.querySelector("img")).toBeNull();
    expect(cover.body.querySelector("h1")?.textContent).toBe("Dune");
    expect(cover.body.querySelector("p")?.textContent).toBe("Frank Herbert");
    expect(cover.body.querySelector("h1")?.style.fontSize).toBe("20px");
    expect(cover.body.querySelector("p")?.style.fontSize).toBe("16px");
  });

  it("does not replace a section that does not contain the cover", async () => {
    bookMock.loaded.cover = Promise.resolve("https://reader.test/OEBPS/cover.jpg");
    new EpubRenderer(new Uint8Array([1]), "Dune", ["Frank Herbert"]);
    const chapter = document.implementation.createHTMLDocument();
    chapter.body.innerHTML = "<p>Chapter text</p>";

    await coverHook()(chapter, { href: "chapter.xhtml" });

    expect(chapter.body.textContent).toBe("Chapter text");
  });

  it("handles malformed percent escapes in cover paths", async () => {
    bookMock.loaded.cover = Promise.resolve("https://reader.test/%E0%A4%A");
    new EpubRenderer(new Uint8Array([1]), "Dune", []);
    const cover = document.implementation.createHTMLDocument();
    cover.head.innerHTML = '<base href="https://reader.test/title.xhtml">';
    cover.body.innerHTML = '<img src="/%E0%A4%A">';

    await expect(coverHook()(cover, { href: "title.xhtml" })).resolves.toBeUndefined();
    expect(cover.body.querySelector("h1")?.textContent).toBe("Dune");
  });

  it("retains the responsive one/two-column behavior", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.setColumns(2);
    expect(renditionMock.spread).toHaveBeenCalledWith("auto", expect.any(Number));

    renderer.setColumns(1);
    expect(renditionMock.spread).toHaveBeenCalledWith("none");
  });

  it("limits the single-column cover layout to the detected cover section", async () => {
    bookMock.loaded.cover = Promise.resolve("https://reader.test/OEBPS/cover.jpg");
    const renderer = new EpubRenderer(new Uint8Array([1]), "Dune", ["Frank Herbert"]);
    const cover = document.implementation.createHTMLDocument();
    cover.head.innerHTML = '<base href="https://reader.test/OEBPS/titlepage.xhtml">';
    cover.body.innerHTML = '<img src="cover.jpg" alt="Cover">';
    await coverHook()(cover, { href: "titlepage.xhtml", index: 0 });
    await renderer.renderTo(document.createElement("div"));
    renderer.setColumns(2);
    renditionMock.spread.mockClear();
    const rendered = renditionMock.on.mock.calls.find(
      ([event]) => event === "rendered",
    )![1];

    rendered({ href: "titlepage.xhtml", index: 0 }, { document: cover });
    expect(renditionMock.spread).toHaveBeenLastCalledWith("none");

    const next = document.implementation.createHTMLDocument();
    rendered({ href: "copyright.xhtml", index: 1 }, { document: next });
    expect(renditionMock.spread).toHaveBeenLastCalledWith("auto", 900);
  });

  it("destroys both the rendition and the book", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.destroy();

    expect(renditionMock.destroy).toHaveBeenCalled();
    expect(bookMock.destroy).toHaveBeenCalled();
    expect(() => renderer.setFontSize("100%")).toThrow(/renderTo/);
    renderer.destroy();
    expect(bookMock.destroy).toHaveBeenCalledTimes(1);
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

  it("marks explicit navigation relocations as user initiated", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    await renderer.renderTo(document.createElement("div"));
    const relocated = renditionMock.on.mock.calls.find(
      ([event]) => event === "relocated",
    )![1];
    const callback = vi.fn();
    renderer.onLocationChange(callback);

    relocated({ start: { cfi: "epubcfi(/6/2)" } });
    await renderer.next();
    relocated({ start: { cfi: "epubcfi(/6/4)" } });

    expect(callback.mock.calls).toEqual([
      [{ cfi: "epubcfi(/6/2)", userInitiated: false }],
      [{ cfi: "epubcfi(/6/4)", userInitiated: true }],
    ]);
  });

  it("captures normalized text following the current CFI for a bookmark", async () => {
    const chapter = document.implementation.createHTMLDocument();
    chapter.body.innerHTML =
      "<p>Fear is the   mind-killer. Fear is the little-death.</p>";
    const text = chapter.querySelector("p")!.firstChild!;
    const range = chapter.createRange();
    range.setStart(text, 12);
    range.collapse(true);
    renditionMock.getRange.mockReturnValue(range);
    const renderer = new EpubRenderer(new Uint8Array([1]));
    await renderer.renderTo(document.createElement("div"));
    const relocated = renditionMock.on.mock.calls.find(
      ([event]) => event === "relocated",
    )![1];
    relocated({ start: { cfi: "epubcfi(/6/4)" } });

    expect(renderer.currentBookmark()).toEqual({
      cfi: "epubcfi(/6/4)",
      preview: "mind-killer. Fear is the little-death.",
    });
  });

  it("reports a stable book-wide page and total when the rendition relocates", async () => {
    bookMock.locations.locationFromCfi.mockReturnValue(2);
    bookMock.locations.generate.mockResolvedValue(
      Array.from({ length: 120 }, (_, index) => `epubcfi(/6/${index + 2})`),
    );
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    const relocated = renditionMock.on.mock.calls.find(
      ([event]) => event === "relocated",
    )![1];
    relocated({ start: { cfi: "epubcfi(/6/4!/4/2)" } });
    const cb = vi.fn();
    renderer.onPageChange(cb);

    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalledWith({ current: 3, total: 120 });
    });

    expect(bookMock.locations.generate).toHaveBeenCalledWith(1000);
    expect(bookMock.locations.locationFromCfi).toHaveBeenCalledWith(
      "epubcfi(/6/4!/4/2)",
    );
  });

  it("publishes the generated total even if the initial relocation was missed", async () => {
    bookMock.locations.generate.mockResolvedValue(
      Array.from({ length: 120 }, (_, index) => `epubcfi(/6/${index + 2})`),
    );
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    const cb = vi.fn();

    renderer.onPageChange(cb);

    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalledWith({ current: 1, total: 120 });
    });
  });

  it("waits for the book to open before generating page locations", async () => {
    let resolveOpened!: () => void;
    bookMock.opened = new Promise((resolve) => {
      resolveOpened = () => resolve({});
    });
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));

    renderer.onPageChange(vi.fn());

    expect(bookMock.locations.generate).not.toHaveBeenCalled();
    resolveOpened();
    await vi.waitFor(() => {
      expect(bookMock.locations.generate).toHaveBeenCalledWith(1000);
    });
  });

  it("jumps to an edited book-wide page", async () => {
    bookMock.locations.generate.mockResolvedValue(
      Array.from({ length: 120 }, (_, index) => `epubcfi(/6/${index + 2})`),
    );
    bookMock.locations.cfiFromLocation.mockReturnValue("epubcfi(/6/84)");
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    renderer.onPageChange(vi.fn());
    await vi.waitFor(() => {
      expect(bookMock.locations.generate).toHaveBeenCalled();
    });
    renditionMock.display.mockClear();

    await renderer.displayPage(42);

    expect(bookMock.locations.cfiFromLocation).toHaveBeenCalledWith(41);
    expect(renditionMock.display).toHaveBeenCalledWith("epubcfi(/6/84)");
  });

  it("ignores an invalid direct page", async () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    renderer.renderTo(document.createElement("div"));
    renderer.onPageChange(vi.fn());
    await vi.waitFor(() => expect(bookMock.locations.generate).toHaveBeenCalled());
    bookMock.locations.cfiFromLocation.mockClear();

    await renderer.displayPage(Number.NaN);

    expect(bookMock.locations.cfiFromLocation).not.toHaveBeenCalled();
  });

  it("setFontSize() updates the theme and reapplies the responsive spread", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 1200 });
    renderer.renderTo(host);
    renderer.setColumns(2);
    renditionMock.spread.mockClear();

    renderer.setFontSize("16px");

    expect(renditionMock.themes.fontSize).toHaveBeenCalledWith("16px");
    expect(renditionMock.settings.gap).toBe(100);
    expect(renditionMock.manager.settings.gap).toBe(100);
    expect(renditionMock.spread).toHaveBeenCalledWith("auto", expect.any(Number));
  });

  it("keeps pages separated in a narrow single-column rendition", () => {
    const renderer = new EpubRenderer(new Uint8Array([1]));
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 360 });
    renderer.renderTo(host);

    renderer.setColumns(2);

    expect(renditionMock.settings.gap).toBe(32);
    expect(renditionMock.manager.settings.gap).toBe(32);
    expect(renditionMock.spread).toHaveBeenLastCalledWith("auto", 900);
  });

  it("reapplies the spread after the host width changes", async () => {
    let resize!: ResizeObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class ResizeObserverMock {
      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;

      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const renderer = new EpubRenderer(new Uint8Array([1]));
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 1100 },
      clientHeight: { value: 700 },
    });

    await renderer.renderTo(host);
    renderer.setColumns(2);
    renditionMock.spread.mockClear();
    resize([], {} as ResizeObserver);

    expect(observe).toHaveBeenCalledWith(host);
    expect(renditionMock.spread).toHaveBeenCalledWith("auto", expect.any(Number));
    expect(renditionMock.resize).toHaveBeenCalledWith(1100, 700, undefined);

    renderer.destroy();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("defers a first-open host resize until the rendition is ready", async () => {
    let resize!: ResizeObserverCallback;
    class ResizeObserverMock {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();

      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const renderer = new EpubRenderer(new Uint8Array([1]));
    const host = document.createElement("div");
    let width = 0;
    Object.defineProperties(host, {
      clientWidth: { get: () => width },
      clientHeight: { value: 700 },
    });
    let resolveDisplay!: () => void;
    renditionMock.display.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveDisplay = resolve;
        }),
    );

    const rendering = renderer.renderTo(host);
    renderer.setColumns(2);
    renditionMock.spread.mockClear();
    width = 1100;
    renditionMock.currentLocation.mockReturnValue({
      start: { cfi: "epubcfi(/6/8)", index: 4 },
    });
    resize([], {} as ResizeObserver);

    expect(renditionMock.resize).not.toHaveBeenCalled();

    resolveDisplay();
    await rendering;

    expect(renditionMock.settings.gap).toBe(100);
    expect(renditionMock.spread).toHaveBeenCalledWith("auto", 900);
    expect(renditionMock.resize).toHaveBeenCalledWith(1100, 700, "epubcfi(/6/8)");
  });

  it("waits for reader and embedded fonts and reflows the current spread", async () => {
    let resolveReaderFont!: () => void;
    let resolveEmbeddedFonts!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReaderFont = resolve;
        }),
    );
    const ready = new Promise<void>((resolve) => {
      resolveEmbeddedFonts = resolve;
    });
    const fontDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(fontDocument, "fonts", {
      value: { load, ready },
    });
    const host = document.createElement("div");
    Object.defineProperties(host, {
      clientWidth: { value: 1100 },
      clientHeight: { value: 700 },
    });
    renditionMock.currentLocation.mockReturnValue({
      start: { cfi: "epubcfi(/6/8)", index: 4 },
    });
    renditionMock.display.mockImplementationOnce(async () => {
      const rendered = renditionMock.on.mock.calls.find(
        ([event]) => event === "rendered",
      )![1];
      rendered({ index: 4 }, { document: fontDocument });
    });
    const renderer = new EpubRenderer(new Uint8Array([1]));

    let complete = false;
    const rendering = renderer.renderTo(host).then(() => {
      complete = true;
    });
    renderer.setColumns(2);
    await Promise.resolve();
    expect(complete).toBe(false);

    resolveReaderFont();
    await Promise.resolve();
    expect(complete).toBe(false);
    resolveEmbeddedFonts();
    await rendering;

    expect(load).toHaveBeenCalledWith("1em 'Txt Literata', serif");
    expect(renditionMock.spread).toHaveBeenLastCalledWith("auto", 900);
    expect(renditionMock.resize).toHaveBeenCalledWith(1100, 700, "epubcfi(/6/8)");
  });

  it("finishes the first render when the reader font stalls", async () => {
    vi.useFakeTimers();
    try {
      const fontDocument = document.implementation.createHTMLDocument();
      Object.defineProperty(fontDocument, "fonts", {
        value: { load: vi.fn(() => new Promise<void>(() => undefined)) },
      });
      const host = document.createElement("div");
      Object.defineProperties(host, {
        clientWidth: { value: 1100 },
        clientHeight: { value: 700 },
      });
      renditionMock.display.mockImplementationOnce(async () => {
        const rendered = renditionMock.on.mock.calls.find(
          ([event]) => event === "rendered",
        )![1];
        rendered({ index: 4 }, { document: fontDocument });
      });
      const renderer = new EpubRenderer(new Uint8Array([1]));

      let complete = false;
      const rendering = renderer.renderTo(host).then(() => {
        complete = true;
      });
      await Promise.resolve();
      expect(complete).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await rendering;

      expect(complete).toBe(true);
      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reflows mobile columns when an embedded font settles late", async () => {
    vi.useFakeTimers();
    try {
      let resolveEmbeddedFonts!: () => void;
      const ready = new Promise<void>((resolve) => {
        resolveEmbeddedFonts = resolve;
      });
      const fontDocument = document.implementation.createHTMLDocument();
      Object.defineProperty(fontDocument, "fonts", {
        value: { load: vi.fn().mockResolvedValue([]), ready },
      });
      const host = document.createElement("div");
      Object.defineProperties(host, {
        clientWidth: { value: 360 },
        clientHeight: { value: 700 },
      });
      renditionMock.currentLocation.mockReturnValue({
        start: { cfi: "epubcfi(/6/8)", index: 4 },
      });
      renditionMock.display.mockImplementationOnce(async () => {
        const rendered = renditionMock.on.mock.calls.find(
          ([event]) => event === "rendered",
        )![1];
        rendered({ index: 4 }, { document: fontDocument });
      });
      const renderer = new EpubRenderer(new Uint8Array([1]));

      const rendering = renderer.renderTo(host);
      renderer.setColumns(2);
      await vi.advanceTimersByTimeAsync(1_000);
      await rendering;
      renditionMock.resize.mockClear();

      resolveEmbeddedFonts();
      await Promise.resolve();

      expect(renditionMock.settings.gap).toBe(32);
      expect(renditionMock.resize).toHaveBeenCalledWith(360, 700, "epubcfi(/6/8)");
      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
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
