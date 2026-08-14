// Opens BB for the requested document (docs/data_model.md §6.1) and shows
// its basic txt/txt_meta fields. Real EPUB rendering (fetching + decrypting
// parts, epub.js) is a later step -- this proves the open+read path works.
import { useParams } from "react-router-dom";
import { useVault } from "../../state/VaultContext";
import { useReaderDocument } from "./useReaderDocument";

export function ReaderScreen() {
  const { txtId } = useParams<{ txtId: string }>();
  const { session } = useVault();
  const { status, document, error } = useReaderDocument(session, Number(txtId));

  if (status === "loading") return <p>Opening your book…</p>;
  if (status === "not-found") return <p>This document could not be found.</p>;
  if (status === "error") return <p role="alert">{error}</p>;

  return (
    <div>
      <h1>{document!.name}</h1>
      <p>{document!.nParts} part(s)</p>
    </div>
  );
}
