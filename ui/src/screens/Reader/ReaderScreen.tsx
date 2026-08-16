// Reader shell: document loading and panel visibility stay here; rendering,
// navigation, toolbar, and metadata presentation live in focused modules.
import { useState } from "react";
import { useParams } from "react-router-dom";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import type { ReaderDocument } from "../../data/readerDocument";
import { useVault } from "../../state/VaultContext";
import { ReaderInfoPanel } from "./ReaderInfoPanel";
import { ReaderNavigation } from "./ReaderNavigation";
import { ReaderToolbar } from "./ReaderToolbar";
import { TocPanel } from "./TocPanel";
import { useEpubRenderer } from "./useEpubRenderer";
import { useReaderDocument } from "./useReaderDocument";

export function ReaderScreen() {
  const { txtId } = useParams<{ txtId: string }>();
  const { session } = useVault();
  const state = useReaderDocument(session, Number(txtId));
  if (state.status === "loading") {
    return <LoadingMessage>Opening your book…</LoadingMessage>;
  }
  if (state.status === "not-found") {
    return <ScreenMessage>This document could not be found.</ScreenMessage>;
  }
  if (state.status === "error") {
    return <ScreenMessage error>{state.error}</ScreenMessage>;
  }
  return <ReadyReader document={state.document} />;
}

function ReadyReader({ document }: { document: ReaderDocument }) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const { setHost, renderer, page, fontPx, changeFontSize, error } =
    useEpubRenderer(document);
  if (error) return <ScreenMessage error>{error}</ScreenMessage>;
  return (
    <div className="d-flex flex-column vh-100 mx-auto max-w-md-80 px-2 px-md-0">
      <ReaderToolbar
        title={document.title}
        authors={document.authors}
        onMenu={() => setTocOpen(true)}
        onInfo={() => setInfoOpen(true)}
      />
      <div ref={setHost} className="flex-grow-1" />
      <ReaderNavigation
        renderer={renderer}
        page={page}
        fontPx={fontPx}
        onFontSize={changeFontSize}
      />
      <ReaderInfoPanel
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        document={document}
      />
      <TocPanel open={tocOpen} onClose={() => setTocOpen(false)} renderer={renderer} />
    </div>
  );
}
