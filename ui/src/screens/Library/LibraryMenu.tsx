import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { BookOpen } from "lucide-react";
import type { LibraryBook } from "../../data/libraryDb";
import type { BookShare } from "../../data/shares";
import type { LibraryView } from "./libraryView";
import { LibrarySidebar } from "./LibrarySidebar";

export function LibraryMenu(props: {
  books: LibraryBook[];
  view: LibraryView;
  displayName: string;
  onNavigate: (view: LibraryView) => void;
  onLock: () => void;
  shares: BookShare[];
}) {
  return (
    <DialogTrigger>
      <Button
        className="btn btn-sm btn-square btn-outline btn-secondary"
        aria-label="Open menu"
      >
        <BookOpen className="size-4" aria-hidden="true" />
      </Button>
      <Popover
        placement="bottom start"
        offset={4}
        className="menu rounded-box border border-base-300 bg-base-100 shadow-lg library-dropdown"
      >
        <Dialog
          aria-label="Library menu"
          className="library-dropdown-dialog outline-none"
        >
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
