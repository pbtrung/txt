// A thin wrapper around epub.ts's Book/Rendition (a drop-in, fully-typed
// rewrite of epub.js -- same API, one dependency, actively maintained) --
// isolates the actual rendering library (it needs a genuine browser:
// iframes, Blob URLs) behind a class ReaderScreen and its tests can mock,
// the same pattern as R2Client wrapping aws4fetch.
import ePub, { type Book, type NavItem, type Rendition } from "@likecoin/epub-ts";
import { READER_FONT_FAMILY, READER_THEME_CSS } from "./readerTheme";

// A 2-column spread only kicks in once there's room for two 80ch-ish
// columns side by side -- otherwise setColumns(2) would just crush both
// columns on a narrow viewport. Approximate, not exact: an actual 80ch
// width depends on the rendered font's own metrics.
const TWO_COLUMN_MIN_WIDTH_PX = 900;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class EpubRenderer {
  private readonly book: Book;
  private rendition: Rendition | null = null;

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
    void this.rendition.display();
  }

  /** 1 = always a single column; 2 = a two-page spread once the viewport
   * is wide enough, otherwise epub.js falls back to one column on its own. */
  setColumns(count: 1 | 2): void {
    const rendition = this.requireRendition();
    if (count === 1) {
      rendition.spread("none");
    } else {
      rendition.spread("auto", TWO_COLUMN_MIN_WIDTH_PX);
    }
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
