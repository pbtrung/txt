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
const FRONT_MATTER_SPINE_INDEX_LIMIT = 3;
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
    return decodeURI(new URL(reference, base).pathname);
  } catch {
    return decodeURI(reference.split(/[?#]/)[0]);
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

export class EpubRenderer {
  private readonly book: Book;
  private rendition: Rendition | null = null;
  private preferredColumns: 1 | 2 = 1;
  private coverHref: string | null = null;
  private currentCfi: string | null = null;
  private pageMapReady = false;
  private pageTotal = 0;
  private pageCallback: ((page: PagePosition) => void) | null = null;

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

  renderTo(element: HTMLElement): void {
    // allowScriptedContent: epub.js's own default (false) sandboxes each
    // section's iframe as just "allow-same-origin", which blocks epub.js's
    // own internal per-section helper script from running (DevTools:
    // "Blocked script execution in 'about:srcdoc'..."), not just any
    // script content an EPUB itself might carry.
    this.rendition = this.book.renderTo(element, {
      width: "100%",
      height: "100%",
      allowScriptedContent: true,
    });
    this.rendition.themes.registerCss("default", READER_THEME_CSS);
    // themes.font(), not a plain CSS rule: it applies as an inline
    // `!important` style per section (Rendition's own override mechanism),
    // which is what it takes to beat a book's own stylesheet -- nearly
    // every real EPUB sets its own font-family on body/paragraphs.
    this.rendition.themes.font(READER_FONT_FAMILY);
    this.rendition.on("rendered", (section) => this.applyLayoutFor(section));
    this.rendition.on("relocated", (location: Location) => {
      this.currentCfi = location.start.cfi;
      this.emitPagePosition();
    });
    void this.loadCoverHref();
    void this.rendition.display();
  }

  private async loadCoverHref(): Promise<void> {
    try {
      this.coverHref = (await this.book.loaded.cover) || null;
    } catch {
      this.coverHref = null;
    }
  }

  private isFrontMatter(section: SectionLike): boolean {
    if (section.index !== undefined && section.index < FRONT_MATTER_SPINE_INDEX_LIMIT)
      return true;
    return (
      this.coverHref !== null &&
      section.href !== undefined &&
      this.book.resolve(section.href) === this.coverHref
    );
  }

  private applyPreferredColumns(): void {
    const rendition = this.requireRendition();
    if (this.preferredColumns === 1) rendition.spread("none");
    else rendition.spread("auto", TWO_COLUMN_MIN_WIDTH_PX);
  }

  private applyLayoutFor(section: SectionLike): void {
    if (this.isFrontMatter(section)) this.requireRendition().spread("none");
    else this.applyPreferredColumns();
  }

  setColumns(count: 1 | 2): void {
    this.preferredColumns = count;
    const current = this.requireRendition().currentLocation()?.start;
    if (!current || !this.isFrontMatter(current)) this.applyPreferredColumns();
  }

  /** Jumps to an arbitrary TOC href or CFI -- unlike next()/prev(), which
   * just step relative to wherever the rendition already is. */
  async display(target: string): Promise<void> {
    await this.requireRendition().display(target);
  }

  async next(): Promise<void> {
    return this.requireRendition().next();
  }

  async prev(): Promise<void> {
    return this.requireRendition().prev();
  }

  async displayPage(page: number): Promise<void> {
    if (!this.pageMapReady || this.pageTotal === 0) return;
    const index = Math.min(this.pageTotal - 1, Math.max(0, Math.trunc(page) - 1));
    const target = this.book.locations.cfiFromLocation(index);
    if (typeof target === "string") await this.requireRendition().display(target);
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
    this.pageCallback({ current: Math.max(0, index) + 1, total: this.pageTotal });
  }

  async getToc(): Promise<NavItem[]> {
    const navigation = await this.book.loaded.navigation;
    return navigation.toc;
  }

  setFontSize(size: string): void {
    this.requireRendition().themes.fontSize(size);
  }

  private requireRendition(): Rendition {
    if (!this.rendition)
      throw new Error("EpubRenderer: renderTo() must be called first");
    return this.rendition;
  }

  destroy(): void {
    this.rendition?.destroy();
    this.book.destroy();
  }
}
