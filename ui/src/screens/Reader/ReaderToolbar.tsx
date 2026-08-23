import { Link, Toolbar } from "react-aria-components";
import { ArrowLeft } from "lucide-react";
import { IconButton } from "../../components/IconButton";

export function ReaderToolbar({
  title,
  authors,
  onMenu,
  onInfo,
  backHref = "/library",
}: {
  title: string;
  authors: string[];
  onMenu: () => void;
  onInfo: () => void;
  backHref?: string | null;
}) {
  return (
    <Toolbar
      aria-label="Reader actions"
      className="reader-toolbar flex items-center gap-1 border-b border-base-300 px-1 py-1"
    >
      {backHref && (
        <Link
          href={backHref}
          className="btn btn-sm btn-square btn-outline btn-secondary"
          aria-label="Back to library"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
      )}
      <h1 className="mx-2 mb-0 flex-1 truncate text-base font-semibold">
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
