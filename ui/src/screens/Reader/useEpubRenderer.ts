import { useCallback, useEffect, useState } from "react";
import {
  EpubRenderer,
  type PagePosition,
  type ReaderLocation,
} from "../../data/epubRenderer";
import type { ReaderDocument } from "../../data/readerDocument";
import { errorMessage } from "../../util/errorMessage";

const DEFAULT_FONT_PX = 18;
const INITIAL_PAGE: PagePosition = { current: 1, total: 1 };

interface MountedRenderer {
  document: ReaderDocument;
  renderer: EpubRenderer;
}

interface LocatedPage {
  document: ReaderDocument;
  page: PagePosition;
}

interface LocatedCfi {
  document: ReaderDocument;
  location: ReaderLocation;
}

interface RenderFailure {
  document: ReaderDocument;
  error: string;
}

export function useEpubRenderer(
  document: ReaderDocument,
  initialCfi: string | null = null,
) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [fontPx, setFontPx] = useState(DEFAULT_FONT_PX);
  const [mounted, setMounted] = useState<MountedRenderer | null>(null);
  const [ready, setReady] = useState<MountedRenderer | null>(null);
  const [located, setLocated] = useState<LocatedPage | null>(null);
  const [location, setLocation] = useState<LocatedCfi | null>(null);
  const [failure, setFailure] = useState<RenderFailure | null>(null);
  useEffect(() => {
    if (!host) return;
    return mountRenderer(
      document,
      initialCfi,
      host,
      setMounted,
      setReady,
      setLocated,
      setLocation,
      setFailure,
    );
  }, [document, host, initialCfi]);
  const renderer = mounted?.document === document ? mounted.renderer : null;
  const page = located?.document === document ? located.page : INITIAL_PAGE;
  const currentLocation = location?.document === document ? location.location : null;
  const error = failure?.document === document ? failure.error : null;
  useEffect(() => renderer?.setFontSize(`${fontPx}px`), [fontPx, renderer]);
  const changeFontSize = useCallback((size: number) => setFontPx(size), []);
  return {
    setHost,
    renderer,
    ready: ready?.document === document && ready.renderer === renderer,
    page,
    location: currentLocation,
    fontPx,
    changeFontSize,
    error,
  };
}

function mountRenderer(
  document: ReaderDocument,
  initialCfi: string | null,
  host: HTMLElement,
  setMounted: (value: MountedRenderer) => void,
  setReady: (value: MountedRenderer) => void,
  setLocated: (value: LocatedPage) => void,
  setLocation: (value: LocatedCfi) => void,
  setFailure: (value: RenderFailure) => void,
) {
  const renderer = new EpubRenderer(
    document.epubBytes,
    document.title,
    document.authors,
  );
  let active = true;
  renderer.onLocationChange(
    (location) => active && setLocation({ document, location }),
  );
  void Promise.resolve(renderer.renderTo(host, initialCfi ?? document.lastCfi)).then(
    () => active && setReady({ document, renderer }),
    (error: unknown) => active && setFailure({ document, error: errorMessage(error) }),
  );
  renderer.setColumns(2);
  renderer.onPageChange((page) => active && setLocated({ document, page }));
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
