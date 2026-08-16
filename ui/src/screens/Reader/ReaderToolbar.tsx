import { Link } from "react-router-dom";
import { IconButton } from "../../components/IconButton";

export function ReaderToolbar({
  title,
  authors,
  onMenu,
  onInfo,
}: {
  title: string;
  authors: string[];
  onMenu: () => void;
  onInfo: () => void;
}) {
  return (
    <div className="reader-toolbar d-flex align-items-center border-bottom py-1 gap-1">
      <Link
        to="/library"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Back to library"
      >
        <i className="bi bi-arrow-left" aria-hidden="true" />
      </Link>
      <h1 className="h6 mb-0 mx-2 text-truncate flex-grow-1">
        {readerTitle(title, authors)}
      </h1>
      <IconButton label="Menu" icon="list" onClick={onMenu} />
      <IconButton label="Book info" icon="info-circle" onClick={onInfo} />
    </div>
  );
}

function readerTitle(title: string, authors: string[]): string {
  return authors.length ? `${title} — ${authors.join(", ")}` : title;
}
