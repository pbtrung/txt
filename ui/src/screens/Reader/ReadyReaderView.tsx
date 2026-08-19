import { useState, type ReactNode } from "react";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import type { DatabaseStoreStatus } from "../../data/databaseStore";
import type { EpubRenderer, PagePosition } from "../../data/epubRenderer";
import {
  READER_LOAD_TOTAL_STEPS,
  type ReaderDocument,
} from "../../data/readerDocument";
import type { BookmarkRecord } from "../../data/readingState";
import { classNames } from "../../util/classNames";
import { ReaderInfoPanel } from "./ReaderInfoPanel";
import { ReaderNavigation } from "./ReaderNavigation";
import { ReaderToolbar } from "./ReaderToolbar";
import { TocPanel } from "./TocPanel";

export interface ReaderRenderState {
  setHost: (host: HTMLDivElement | null) => void;
  renderer: EpubRenderer | null;
  ready: boolean;
  page: PagePosition;
  fontPx: number;
  changeFontSize: (size: number) => void;
  error: string | null;
}

export interface ReaderReadingState {
  bookmarks: BookmarkRecord[];
  bookmarkBusy: boolean;
  currentSaved: boolean;
  toggleCurrent: (pageNumber: number) => void | Promise<void>;
  remove: (cfi: string) => void | Promise<void>;
  retry: () => void | Promise<void>;
  databaseStatus: DatabaseStoreStatus;
  error: string | null;
}

export function ReadyReaderView({
  document,
  reading,
  backHref = "/library",
  setHost,
  renderer,
  ready,
  page,
  fontPx,
  changeFontSize,
  error,
}: {
  document: ReaderDocument;
  reading: ReaderReadingState;
  backHref?: string | null;
} & ReaderRenderState) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [readerContainer, setReaderContainer] = useState<HTMLDivElement | null>(null);
  if (error) return <ReaderError>{error}</ReaderError>;
  return (
    <div
      ref={setReaderContainer}
      className="reader-width vh-100 mx-auto position-relative"
    >
      <div className="reader-column d-flex flex-column h-100 px-2 px-md-0">
        <ReaderToolbar
          title={document.title}
          authors={document.authors}
          onMenu={() => setTocOpen(true)}
          onInfo={() => setInfoOpen(true)}
          backHref={backHref}
        />
        <div
          className="reader-viewport flex-grow-1 align-self-center position-relative"
          style={{ fontSize: `${fontPx}px` }}
        >
          <div
            ref={setHost}
            className={classNames("reader-epub-host h-100", !ready && "invisible")}
          />
          {!ready && (
            <LoadingMessage
              compact
              progress={{
                label: "Laying out text",
                step: READER_LOAD_TOTAL_STEPS,
                total: READER_LOAD_TOTAL_STEPS,
              }}
            >
              Preparing your book…
            </LoadingMessage>
          )}
        </div>
        <ReaderNavigation
          renderer={renderer}
          page={page}
          fontPx={fontPx}
          onFontSize={changeFontSize}
          bookmarkSaved={reading.currentSaved}
          bookmarkBusy={reading.bookmarkBusy}
          bookmarks={reading.bookmarks}
          status={reading.databaseStatus}
          error={reading.error}
          onBookmark={() => void reading.toggleCurrent(page.current)}
          onRemove={(cfi) => void reading.remove(cfi)}
          onRetry={() => void reading.retry()}
        />
        <ReaderInfoPanel
          open={infoOpen}
          onClose={() => setInfoOpen(false)}
          document={document}
          portalContainer={readerContainer ?? undefined}
        />
        <TocPanel
          open={tocOpen}
          onClose={() => setTocOpen(false)}
          renderer={renderer}
          portalContainer={readerContainer ?? undefined}
        />
      </div>
    </div>
  );
}

export function ReaderError({ children }: { children: ReactNode }) {
  return (
    <div className="reader-width reader-column mx-auto px-2 px-md-0">
      <ScreenMessage error compact>
        {children}
      </ScreenMessage>
    </div>
  );
}
