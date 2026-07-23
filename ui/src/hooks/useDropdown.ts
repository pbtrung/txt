// Shared behavior behind every hand-rolled dropdown in this app (Library's
// nav drawer, Reader's Info and Bookmarks menus): there's no Bootstrap JS in
// this project (only its CSS), so open/closed state and "close on an outside
// click or Escape" are all hand-rolled here instead of relying on its
// dropdown plugin. Each call is independent -- two dropdowns that should
// close each other out (e.g. Reader's Info/Bookmarks) do that by having their
// owning screen call one's `close()` from the other's toggle, not by sharing
// state here.

import { useEffect, useRef, useState } from "react";

export interface DropdownControls {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Attach to the dropdown's wrapper element (the one containing both the
   * toggle button and the menu) -- an outside click is anything outside it. */
  ref: React.RefObject<HTMLDivElement | null>;
}

export function useDropdown(): DropdownControls {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return { open, toggle: () => setOpen((o) => !o), close: () => setOpen(false), ref };
}
