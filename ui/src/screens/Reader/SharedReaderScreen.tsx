import { useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import { parseSharedReference } from "../../data/sharedReader";
import type { ReaderDocument } from "../../data/readerDocument";
import { ReaderError, ReadyReaderView } from "./ReadyReaderView";
import { useEpubRenderer } from "./useEpubRenderer";
import { useSharedReaderDocument } from "./useSharedReaderDocument";
import { sharedLastCfi, useSharedReadingState } from "./useSharedReadingState";

export function SharedReaderScreen() {
  const location = useLocation();
  const reference = useMemo(() => parseSharedReference(location.hash), [location.hash]);
  const state = useSharedReaderDocument(reference);
  if (state.status === "invalid") {
    return <ScreenMessage>This share link is invalid.</ScreenMessage>;
  }
  if (state.status === "loading") {
    return (
      <LoadingMessage progress={state.progress}>Opening shared book…</LoadingMessage>
    );
  }
  if (state.status === "error") return <ReaderError>{state.error}</ReaderError>;
  if (!reference) return <ScreenMessage>This share link is invalid.</ScreenMessage>;
  return (
    <ReadySharedReader
      key={reference.id}
      document={state.document}
      shareId={reference.id}
    />
  );
}

function ReadySharedReader({
  document,
  shareId,
}: {
  document: ReaderDocument;
  shareId: string;
}) {
  const [initialCfi] = useState(() => sharedLastCfi(shareId));
  const reader = useEpubRenderer(document, initialCfi);
  const reading = useSharedReadingState(
    shareId,
    reader.renderer,
    reader.ready,
    reader.location,
  );
  return (
    <ReadyReaderView
      document={document}
      reading={reading}
      backHref={null}
      {...reader}
    />
  );
}
