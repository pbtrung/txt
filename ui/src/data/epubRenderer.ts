// A thin wrapper around epub.js's Book/Rendition -- isolates the actual
// rendering library (real epub.js needs a genuine browser: iframes, Blob
// URLs) behind a class ReaderScreen and its tests can mock, the same
// pattern as R2Client wrapping aws4fetch.
import ePub, { type Book, type Rendition } from "epubjs";

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
    this.rendition = this.book.renderTo(element, { width: "100%", height: "100%" });
    void this.rendition.display();
  }

  destroy(): void {
    this.rendition?.destroy();
    this.book.destroy();
  }
}
