// A thin wrapper around epub.ts's Book/Rendition (a drop-in, fully-typed
// rewrite of epub.js -- same API, one dependency, actively maintained) --
// isolates the actual rendering library (it needs a genuine browser:
// iframes, Blob URLs) behind a class ReaderScreen and its tests can mock,
// the same pattern as R2Client wrapping aws4fetch.
import ePub, { type Book, type NavItem, type Rendition } from "@likecoin/epub-ts";
import type { ColumnLayout } from "./columnLayout";
import { READER_FONT_FAMILY, READER_THEME_CSS } from "./readerTheme";

// epub.ts applies spread mode uniformly across every section of a
// reflowable book -- its per-item page-spread-left/right handling only
// applies to pre-paginated (fixed) layouts, so there's no built-in
// exemption for a book's own front matter. A cover page (typically one
// full-bleed image) or an early title/copyright/TOC page can genuinely
// come out wrong split across two CSS columns the same way body text
// would flow across them, so those always render single-column instead,
// regardless of the column preference:
//  - the cover specifically, matched via the book's own declared cover
//    path (book.loaded.cover) -- precise, not a guess.
//  - a fallback in case the cover isn't caught above (front matter
//    doesn't always start at spine index 0, or a book declares no cover
//    at all): the first few spine positions, a heuristic that covers
//    title/copyright/TOC pages in most real books without reaching far
//    enough to catch genuine chapter 1 content in the ones with little
//    front matter.
const FRONT_MATTER_SPINE_INDEX_LIMIT = 3;

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

export class EpubRenderer {
  private readonly book: Book;
  private rendition: Rendition | null = null;
  private preferredLayout: ColumnLayout = { columns: 1, gapPx: 0, maxWidthPx: null };
  private coverHref: string | null = null;

  constructor(epubBytes: Uint8Array) {
    this.book = ePub(toArrayBuffer(epubBytes));
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
    if (section.index !== undefined && section.index < FRONT_MATTER_SPINE_INDEX_LIMIT) {
      return true;
    }
    return (
      this.coverHref !== null &&
      section.href !== undefined &&
      this.book.resolve(section.href) === this.coverHref
    );
  }

  private applyPreferredLayout(): void {
    const rendition = this.requireRendition();
    const layout = this.preferredLayout;
    if (layout.columns === 1) {
      rendition.spread("none");
      return;
    }
    rendition.settings.gap = layout.gapPx;
    rendition.spread("auto", 1);
  }

  private applyLayoutFor(section: SectionLike): void {
    if (this.isFrontMatter(section)) {
      this.requireRendition().spread("none");
      return;
    }
    this.applyPreferredLayout();
  }

  /** ui/src/data/columnLayout.ts decides both the column count and the
   * gap between them (shrinking the gap, then the columns themselves,
   * before ever dropping to one column) -- this just applies that
   * decision, unless the currently displayed section is front matter
   * (see FRONT_MATTER_SPINE_INDEX_LIMIT above), which always stays
   * single-column regardless. `spread()` is what actually triggers
   * Rendition's manager to recompute layout, so it's still called even
   * when only the gap (not the column count) changed; `settings.gap`
   * alone wouldn't take effect until the next layout pass otherwise.
   * minSpreadWidth is set to 1 (not epub.js's own auto-detection) since
   * the column-count decision has already been made externally, based on
   * the container's actual measured width. */
  setColumnLayout(layout: ColumnLayout): void {
    this.preferredLayout = layout;
    const current = this.requireRendition().currentLocation()?.start;
    if (current && this.isFrontMatter(current)) return;
    this.applyPreferredLayout();
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

  /** epub.js relays DOM events (keydown/keyup/click/...) up from inside the
   * rendered iframe's content -- this is the only way a keyboard shortcut
   * sees keypresses while focus is inside the book itself, not just the
   * outer page. */
  onKeyup(cb: (event: KeyboardEvent) => void): void {
    this.requireRendition().on("keyup", cb);
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
