// A thin wrapper around epub.ts's Book/Rendition (a drop-in, fully-typed
// rewrite of epub.js -- same API, one dependency, actively maintained) --
// isolates the actual rendering library (it needs a genuine browser:
// iframes, Blob URLs) behind a class ReaderScreen and its tests can mock,
// the same pattern as R2Client wrapping aws4fetch.
import ePub, {
  type Book,
  type Location,
  type NavItem,
  type Rendition,
  type Section,
} from "@likecoin/epub-ts";
import { READER_FONT_FAMILY, READER_THEME_CSS } from "./readerTheme";

const TWO_COLUMN_MIN_WIDTH_PX = 900;
const COLUMN_GAP_PX = 100;
const MOBILE_COLUMN_GAP_PX = 16;
const MOBILE_MAX_WIDTH_PX = 767.98;
const INITIAL_FONT_WAIT_MS = 1_000;
const BOOK_PAGE_CHARS = 1000;
const COVER_MEDIA_SELECTOR = "img, image, object";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

interface SectionLike {
  href?: string;
  index?: number;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function resourcePath(reference: string, base: string): string {
  try {
    return decodedPath(new URL(reference, base).pathname);
  } catch {
    return decodedPath(reference.split(/[?#]/)[0]);
  }
}

function decodedPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function mediaReference(element: Element): string | null {
  return (
    element.getAttribute("src") ??
    element.getAttribute("href") ??
    element.getAttribute("xlink:href") ??
    element.getAttributeNS(XLINK_NAMESPACE, "href") ??
    element.getAttribute("data")
  );
}

function titlePage(document: Document, title: string, authors: string[]): HTMLElement {
  const page = document.createElement("main");
  page.style.cssText =
    "min-height:90vh!important;display:flex!important;flex-direction:column!important;" +
    "justify-content:center!important;text-align:center!important;padding:2rem!important;" +
    "box-sizing:border-box!important";
  page.append(titleHeading(document, title));
  if (authors.length > 0) page.append(authorLine(document, authors));
  return page;
}

function titleHeading(document: Document, title: string): HTMLElement {
  const heading = document.createElement("h1");
  heading.style.cssText =
    "font-size:20px!important;line-height:1.1!important;margin:0!important";
  heading.textContent = title;
  return heading;
}

function authorLine(document: Document, authors: string[]): HTMLElement {
  const line = document.createElement("p");
  line.style.cssText =
    "font-size:16px!important;line-height:1.3!important;margin:1rem 0 0!important";
  line.textContent = authors.join(", ");
  return line;
}

export interface PagePosition {
  current: number;
  total: number;
}

export interface ReaderLocation {
  cfi: string;
  userInitiated: boolean;
}

export interface CurrentBookmark {
  cfi: string;
  preview: string;
}

export class EpubRenderer {
  private readonly book: Book;
  private rendition: Rendition | null = null;
  private host: HTMLElement | null = null;
  private hostResizeObserver: ResizeObserver | null = null;
  private initialDisplayComplete = false;
  private hostResizePending = false;
  private pendingFontLayouts = new Set<Promise<void>>();
  private hostWidth = 0;
  private preferredColumns: 1 | 2 = 1;
  private coverHref: string | null = null;
  private coverSectionIndex: number | null = null;
  private coverSectionHref: string | null = null;
  private currentCfi: string | null = null;
  private pageMapReady = false;
  private pageTotal = 0;
  private pageCallback: ((page: PagePosition) => void) | null = null;
  private locationCallback: ((location: ReaderLocation) => void) | null = null;
  private navigationPending = false;
  private destroyed = false;

  constructor(
    epubBytes: Uint8Array,
    private readonly title: string,
    private readonly authors: string[],
  ) {
    this.book = ePub(toArrayBuffer(epubBytes));
    this.book.spine.hooks.content.register((document, section) =>
      this.replaceCover(document as Document, section as Section),
    );
  }

  private async replaceCover(document: Document, section: Section): Promise<void> {
    const coverHref = await this.book.loaded.cover;
    if (!coverHref || !this.containsCover(document, section, coverHref)) return;
    this.coverSectionIndex = section.index ?? null;
    this.coverSectionHref = section.href ? this.book.resolve(section.href) : null;
    const body = document.body;
    if (body) body.replaceChildren(titlePage(document, this.title, this.authors));
  }

  private containsCover(
    document: Document,
    section: Section,
    coverHref: string,
  ): boolean {
    const coverPath = resourcePath(coverHref, document.baseURI);
    if (
      section.href &&
      resourcePath(section.url ?? section.href, document.baseURI) === coverPath
    )
      return true;
    return Array.from(document.querySelectorAll(COVER_MEDIA_SELECTOR)).some(
      (element) => {
        const reference = mediaReference(element);
        return (
          reference !== null && resourcePath(reference, document.baseURI) === coverPath
        );
      },
    );
  }

  async renderTo(element: HTMLElement, initialCfi?: string | null): Promise<void> {
    if (this.destroyed) throw new Error("EpubRenderer has been destroyed");
    if (this.rendition) throw new Error("EpubRenderer is already mounted");
    // EPUB content is untrusted. Keep scripts disabled so the iframe remains
    // sandboxed as allow-same-origin without the dangerous allow-scripts pair.
    this.host = element;
    this.hostWidth = element.clientWidth;
    const rendition = this.book.renderTo(element, {
      width: "100%",
      height: "100%",
      allowScriptedContent: false,
    });
    this.rendition = rendition;
    rendition.themes.registerCss("default", READER_THEME_CSS);
    // Keep epub.ts's body-level override as well as the theme's descendant
    // rule so both inherited and element-level book fonts are replaced.
    rendition.themes.font(READER_FONT_FAMILY);
    rendition.on("rendered", (section, view) => {
      this.applyLayoutFor(section);
      this.reflowAfterFontsLoad(section, view.document);
    });
    rendition.on("relocated", (location: Location) => {
      this.currentCfi = location.start.cfi;
      const userInitiated = this.navigationPending;
      this.navigationPending = false;
      this.locationCallback?.({ cfi: this.currentCfi, userInitiated });
      this.emitPagePosition();
    });
    this.observeHostSize(element);
    void this.loadCoverHref();
    let displayed = false;
    if (initialCfi) {
      try {
        await rendition.display(initialCfi);
        displayed = true;
      } catch {
        // A stale or malformed CFI must not prevent the book from opening.
      }
    }
    if (this.destroyed || this.rendition !== rendition) return;
    if (!displayed) await rendition.display();
    if (this.destroyed || this.rendition !== rendition) return;
    this.initialDisplayComplete = true;
    this.flushHostResize();
    await this.waitForFontLayouts();
  }

  private reflowAfterFontsLoad(section: SectionLike, document: Document): void {
    const fonts = document.fonts;
    if (!fonts || typeof fonts.load !== "function") return;
    this.queueFontLayout(section, fonts.load(`1em ${READER_FONT_FAMILY}`));
    this.queueFontLayout(section, fonts.ready);
  }

  private queueFontLayout(section: SectionLike, fontLoad: PromiseLike<unknown>): void {
    const pending = Promise.resolve(fontLoad)
      .then(() => {
        this.reflowSection(section);
      })
      .catch(() => {
        // Keep the rendered fallback if a reader or EPUB font fails.
      });
    this.pendingFontLayouts.add(pending);
    void pending.finally(() => this.pendingFontLayouts.delete(pending));
  }

  private reflowSection(section: SectionLike): void {
    if (!this.rendition || !this.host || this.destroyed) return;
    const current = this.rendition.currentLocation()?.start;
    if (current?.index !== undefined && section.index !== undefined) {
      if (current.index !== section.index) return;
    }
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.hostWidth = width;
    this.applyLayoutFor(current ?? section);
    this.rendition.resize(width, height, current?.cfi);
  }

  private async waitForFontLayouts(): Promise<void> {
    await Promise.all(
      [...this.pendingFontLayouts].map((pending) =>
        settleWithin(pending, INITIAL_FONT_WAIT_MS),
      ),
    );
  }

  private async loadCoverHref(): Promise<void> {
    try {
      this.coverHref = (await this.book.loaded.cover) || null;
    } catch {
      this.coverHref = null;
    }
  }

  private isCoverSection(section: SectionLike): boolean {
    if (
      section.index !== undefined &&
      this.coverSectionIndex !== null &&
      section.index === this.coverSectionIndex
    ) {
      return true;
    }
    const sectionHref =
      section.href === undefined ? null : this.book.resolve(section.href);
    return (
      sectionHref !== null &&
      (sectionHref === this.coverSectionHref || sectionHref === this.coverHref)
    );
  }

  private applyPreferredColumns(): void {
    const rendition = this.requireRendition();
    this.updateColumnGap();
    if (this.preferredColumns === 1) rendition.spread("none");
    else rendition.spread("auto", TWO_COLUMN_MIN_WIDTH_PX);
  }

  private applyLayoutFor(section: SectionLike): void {
    if (this.isCoverSection(section)) {
      this.setColumnGap(0);
      this.requireRendition().spread("none");
    } else this.applyPreferredColumns();
  }

  private updateColumnGap(): void {
    const gap =
      this.hostWidth <= MOBILE_MAX_WIDTH_PX ? MOBILE_COLUMN_GAP_PX : COLUMN_GAP_PX;
    this.setColumnGap(gap);
  }

  private setColumnGap(gap: number): void {
    const rendition = this.requireRendition();
    rendition.settings.gap = gap;
    if (rendition.manager?.settings) rendition.manager.settings.gap = gap;
  }

  private observeHostSize(host: HTMLElement): void {
    if (typeof ResizeObserver === "undefined") return;
    this.hostResizeObserver = new ResizeObserver(() => {
      this.hostResizePending = true;
      this.flushHostResize();
    });
    this.hostResizeObserver.observe(host);
  }

  private flushHostResize(): void {
    if (!this.hostResizePending || !this.initialDisplayComplete) return;
    const rendition = this.rendition;
    const host = this.host;
    if (!rendition || !host || this.destroyed) return;
    const manager = rendition.manager;
    if (!manager || !manager.isRendered()) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width <= 0 || height <= 0) return;
    this.hostResizePending = false;
    this.hostWidth = width;
    const current = rendition.currentLocation()?.start;
    if (current) this.applyLayoutFor(current);
    else this.applyPreferredColumns();
    rendition.resize(width, height, current?.cfi);
  }

  setColumns(count: 1 | 2): void {
    this.preferredColumns = count;
    const current = this.requireRendition().currentLocation()?.start;
    if (!current || !this.isCoverSection(current)) this.applyPreferredColumns();
  }

  /** Jumps to an arbitrary TOC href or CFI -- unlike next()/prev(), which
   * just step relative to wherever the rendition already is. */
  async display(target: string): Promise<void> {
    this.navigationPending = true;
    try {
      await this.requireRendition().display(target);
    } catch (error) {
      this.navigationPending = false;
      throw error;
    }
  }

  async next(): Promise<void> {
    this.navigationPending = true;
    try {
      return await this.requireRendition().next();
    } catch (error) {
      this.navigationPending = false;
      throw error;
    }
  }

  async prev(): Promise<void> {
    this.navigationPending = true;
    try {
      return await this.requireRendition().prev();
    } catch (error) {
      this.navigationPending = false;
      throw error;
    }
  }

  async displayPage(page: number): Promise<void> {
    if (!this.pageMapReady || this.pageTotal === 0 || !Number.isFinite(page)) return;
    const index = Math.min(this.pageTotal - 1, Math.max(0, Math.trunc(page) - 1));
    const target = this.book.locations.cfiFromLocation(index);
    if (typeof target === "string") await this.display(target);
  }

  /** epub.js relays DOM events (keydown/keyup/click/...) up from inside the
   * rendered iframe's content -- this is the only way a keyboard shortcut
   * sees keypresses while focus is inside the book itself, not just the
   * outer page. */
  onKeyup(cb: (event: KeyboardEvent) => void): void {
    this.requireRendition().on("keyup", cb);
  }

  onPageChange(cb: (page: PagePosition) => void): void {
    this.pageCallback = cb;
    void this.generatePageMap();
  }

  onLocationChange(cb: (location: ReaderLocation) => void): void {
    this.locationCallback = cb;
    if (this.currentCfi) cb({ cfi: this.currentCfi, userInitiated: false });
  }

  currentBookmark(): CurrentBookmark | null {
    if (!this.currentCfi) return null;
    const rendition = this.requireRendition();
    let text = "";
    try {
      const range = rendition.getRange(this.currentCfi);
      if (range) text = textFollowingRange(range);
    } catch {
      // Fall back to the rendered section's text below.
    }
    if (!text) {
      text = rendition.getContents()[0]?.document.body?.textContent ?? "";
    }
    return { cfi: this.currentCfi, preview: normalizePreview(text) };
  }

  private async generatePageMap(): Promise<void> {
    try {
      await this.book.opened;
      const locations = await this.book.locations.generate(BOOK_PAGE_CHARS);
      this.pageTotal = locations.length;
      this.pageMapReady = this.pageTotal > 0;
      this.currentCfi ??= this.requireRendition().currentLocation()?.start.cfi ?? null;
      this.emitPagePosition();
    } catch {
      this.pageMapReady = false;
    }
  }

  private emitPagePosition(): void {
    if (!this.pageMapReady || !this.pageCallback) return;
    const index = this.currentCfi
      ? this.book.locations.locationFromCfi(this.currentCfi)
      : 0;
    const locationIndex = Number.isFinite(index) ? index : 0;
    const current = Math.min(this.pageTotal, Math.max(0, locationIndex) + 1);
    this.pageCallback({ current, total: this.pageTotal });
  }

  async getToc(): Promise<NavItem[]> {
    const navigation = await this.book.loaded.navigation;
    return navigation.toc;
  }

  setFontSize(size: string): void {
    const rendition = this.requireRendition();
    rendition.themes.fontSize(size);
    const current = rendition.currentLocation()?.start;
    if (current) this.applyLayoutFor(current);
    else this.applyPreferredColumns();
  }

  private requireRendition(): Rendition {
    if (!this.rendition)
      throw new Error("EpubRenderer: renderTo() must be called first");
    return this.rendition;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hostResizeObserver?.disconnect();
    this.hostResizeObserver = null;
    this.host = null;
    this.initialDisplayComplete = false;
    this.hostResizePending = false;
    this.pendingFontLayouts.clear();
    this.rendition?.destroy();
    this.rendition = null;
    this.pageCallback = null;
    this.locationCallback = null;
    this.book.destroy();
  }
}

function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, timeoutMs);
    void promise.then(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

function textFollowingRange(range: Range): string {
  const root = range.startContainer.ownerDocument?.body;
  if (!root) return "";
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const parts: string[] = [];
  let foundStart = false;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!foundStart) {
      if (node !== range.startContainer && !range.startContainer.contains(node)) {
        continue;
      }
      foundStart = true;
      const value = node.textContent ?? "";
      parts.push(
        node === range.startContainer ? value.slice(range.startOffset) : value,
      );
    } else {
      parts.push(node.textContent ?? "");
    }
    if (parts.join(" ").length >= 240) break;
  }
  return parts.join(" ");
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}
