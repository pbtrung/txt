import { Link, Toolbar } from "react-aria-components";
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
    <Toolbar
      aria-label="Reader actions"
      className="reader-toolbar d-flex align-items-center border-bottom py-1 gap-1"
    >
      <Link
        href="/library"
        className="btn btn-sm btn-outline-secondary"
        aria-label="Back to library"
      >
        <i className="bi bi-arrow-left" aria-hidden="true" />
      </Link>
      <h1 className="h6 mb-0 mx-2 text-truncate flex-grow-1">
        {readerTitle(title, authors)}
      </h1>
      <IconButton label="Menu" icon="list" onPress={onMenu} />
      <IconButton label="Book info" icon="info-circle" onPress={onInfo} />
    </Toolbar>
  );
}

function readerTitle(title: string, authors: string[]): string {
  return authors.length ? `${title} — ${authors.join(", ")}` : title;
}
