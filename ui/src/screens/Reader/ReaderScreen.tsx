// Reader shell: document loading and panel visibility stay here; rendering,
// navigation, toolbar, and metadata presentation live in focused modules.
import { useParams, useSearchParams } from "react-router-dom";
import { LoadingMessage, ScreenMessage } from "../../components/ScreenMessage";
import type { ReaderDocument } from "../../data/readerDocument";
import { useVault, type VaultSession } from "../../state/VaultContext";
import { ReaderError, ReadyReaderView } from "./ReadyReaderView";
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
  const reader = useEpubRenderer(document, initialCfi);
  const reading = useReadingState(
    session,
    document,
    reader.renderer,
    reader.ready,
    reader.location,
  );
  return <ReadyReaderView document={document} reading={reading} {...reader} />;
}
