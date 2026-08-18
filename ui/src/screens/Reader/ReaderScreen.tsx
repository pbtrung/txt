// Reader shell: document loading and panel visibility stay here; rendering,
// navigation, toolbar, and metadata presentation live in focused modules.
import { useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import {
  READER_LOAD_TOTAL_STEPS,
  type ReaderDocument,
} from "../../data/readerDocument";
import { useVault, type VaultSession } from "../../state/VaultContext";
import { ReaderInfoPanel } from "./ReaderInfoPanel";
import { ReaderNavigation } from "./ReaderNavigation";
import { ReaderToolbar } from "./ReaderToolbar";
import { TocPanel } from "./TocPanel";
import { useEpubRenderer } from "./useEpubRenderer";
import { useReadingState } from "./useReadingState";
import { useReaderDocument } from "./useReaderDocument";

export function ReaderScreen() {
  const { txtId } = useParams<{ txtId: string }>();
  const [searchParams] = useSearchParams();
  const initialCfi = searchParams.get("cfi");
  const { session } = useVault();
  const state = useReaderDocument(session, Number(txtId));
  if (state.status === "loading") {
    return (
      <LoadingMessage progress={state.progress}>Opening your book…</LoadingMessage>
    );
  }
  if (state.status === "not-found") {
    return <ScreenMessage>This document could not be found.</ScreenMessage>;
  }
  if (state.status === "error") {
    return <ReaderError>{state.error}</ReaderError>;
  }
  if (!session) return <LoadingMessage>Opening your book…</LoadingMessage>;
  return (
    <ReadyReader document={state.document} session={session} initialCfi={initialCfi} />
  );
}

function ReadyReader({
  document,
  session,
  initialCfi,
}: {
  document: ReaderDocument;
  session: VaultSession;
  initialCfi: string | null;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const { setHost, renderer, ready, page, location, fontPx, changeFontSize, error } =
    useEpubRenderer(document, initialCfi);
  const reading = useReadingState(session, document, renderer, ready, location);
  if (error) return <ReaderError>{error}</ReaderError>;
  return (
    <div className="reader-width vh-100 mx-auto">
      <div className="reader-column d-flex flex-column h-100 px-2 px-md-0">
        <ReaderToolbar
          title={document.title}
          authors={document.authors}
          onMenu={() => setTocOpen(true)}
          onInfo={() => setInfoOpen(true)}
        />
        <div
          className="reader-viewport flex-grow-1 align-self-center position-relative"
          style={{ fontSize: `${fontPx}px` }}
        >
          <div ref={setHost} className="reader-epub-host h-100" />
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
        />
        <TocPanel
          open={tocOpen}
          onClose={() => setTocOpen(false)}
          renderer={renderer}
        />
      </div>
    </div>
  );
}

function ReaderError({ children }: { children: ReactNode }) {
  return (
    <div className="reader-width reader-column mx-auto px-2 px-md-0">
      <ScreenMessage error compact>
        {children}
      </ScreenMessage>
    </div>
  );
}
