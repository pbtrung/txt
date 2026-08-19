import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import type { LibraryBook } from "../../data/libraryDb";
import type { LibraryView } from "./libraryView";
import { LibrarySidebar } from "./LibrarySidebar";

export function LibraryMenu(props: {
  books: LibraryBook[];
  view: LibraryView;
  displayName: string;
  onNavigate: (view: LibraryView) => void;
  onLock: () => void;
}) {
  return (
    <DialogTrigger>
      <Button className="btn btn-sm btn-outline-secondary" aria-label="Open menu">
        <i className="bi bi-book" aria-hidden="true" />
      </Button>
      <Popover
        placement="bottom start"
        offset={4}
        className="library-dropdown border rounded shadow bg-body"
      >
        <Dialog aria-label="Library menu" className="library-dropdown-dialog">
          {({ close }) => (
            <LibrarySidebar
              {...props}
              onNavigate={(view) => {
                props.onNavigate(view);
                close();
              }}
              onLock={() => {
                props.onLock();
                close();
              }}
            />
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
