import { useCallback, useEffect, useState } from "react";
import { EpubRenderer, type PagePosition } from "../../data/epubRenderer";
import type { ReaderDocument } from "../../data/readerDocument";
import { errorMessage } from "../../util/errorMessage";

const MOBILE_MEDIA_QUERY = "(max-width: 767.98px)";
const INITIAL_PAGE: PagePosition = { current: 1, total: 1 };

interface MountedRenderer {
  document: ReaderDocument;
  renderer: EpubRenderer;
}

interface LocatedPage {
  document: ReaderDocument;
  page: PagePosition;
}

interface RenderFailure {
  document: ReaderDocument;
  error: string;
}

export function useEpubRenderer(document: ReaderDocument) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [fontPx, setFontPx] = useState(defaultFontPx);
  const [mounted, setMounted] = useState<MountedRenderer | null>(null);
  const [located, setLocated] = useState<LocatedPage | null>(null);
  const [failure, setFailure] = useState<RenderFailure | null>(null);
  useEffect(() => {
    if (!host) return;
    return mountRenderer(document, host, setMounted, setLocated, setFailure);
  }, [document, host]);
  const renderer = mounted?.document === document ? mounted.renderer : null;
  const page = located?.document === document ? located.page : INITIAL_PAGE;
  const error = failure?.document === document ? failure.error : null;
  useEffect(() => renderer?.setFontSize(`${fontPx}px`), [fontPx, renderer]);
  const changeFontSize = useCallback((size: number) => setFontPx(size), []);
  return { setHost, renderer, page, fontPx, changeFontSize, error };
}

function defaultFontPx(): number {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches ? 16 : 18;
}

function mountRenderer(
  document: ReaderDocument,
  host: HTMLElement,
  setMounted: (value: MountedRenderer) => void,
  setLocated: (value: LocatedPage) => void,
  setFailure: (value: RenderFailure) => void,
) {
  const renderer = new EpubRenderer(
    document.epubBytes,
    document.title,
    document.authors,
  );
  let active = true;
  void Promise.resolve(renderer.renderTo(host)).catch(
    (error: unknown) => active && setFailure({ document, error: errorMessage(error) }),
  );
  renderer.setColumns(2);
  renderer.onPageChange((page) => setLocated({ document, page }));
  const removeKeys = registerPageKeys(renderer);
  setMounted({ document, renderer });
  return () => {
    active = false;
    removeKeys();
    renderer.destroy();
  };
}

function registerPageKeys(renderer: EpubRenderer): () => void {
  const onKeyup = (event: KeyboardEvent) => {
    if (isEditing(event.target)) return;
    if (event.key === "ArrowLeft") void renderer.prev();
    if (event.key === "ArrowRight") void renderer.next();
  };
  window.addEventListener("keyup", onKeyup);
  renderer.onKeyup(onKeyup);
  return () => window.removeEventListener("keyup", onKeyup);
}

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}
