// Shared behavior behind every hand-rolled dropdown in this app (Library's
// nav drawer, Reader's Info and Bookmarks menus): there's no
// Bootstrap JS in this project (only its CSS), so open/closed state and
// "close on an outside click or Escape" are all hand-rolled here instead of
// relying on its dropdown plugin. Each call is independent -- two dropdowns
// that should close each other out (e.g. Reader's Info/Bookmarks) do that by
// having their owning screen call one's `close()` from the other's toggle,
// not by sharing state here.

import { useCallback, useEffect, useRef, useState } from "react";

export interface DropdownControls {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** Attach to the dropdown's wrapper element (the one containing both the
   * toggle button and the menu) -- an outside click is anything outside it. */
  ref: React.RefObject<HTMLDivElement | null>;
}

function onDocument<K extends keyof DocumentEventMap>(
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
): () => void {
  document.addEventListener(type, handler);
  return () => document.removeEventListener(type, handler);
}

function containsTarget(
  ref: React.RefObject<HTMLDivElement | null>,
  target: EventTarget | null,
): boolean {
  return target instanceof Node && Boolean(ref.current?.contains(target));
}

function useDropdownDismissal(
  open: boolean,
  ref: React.RefObject<HTMLDivElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const offPointer = onDocument("mousedown", (event) => {
      if (!containsTarget(ref, event.target)) close();
    });
    const offKey = onDocument("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    return () => {
      offPointer();
      offKey();
    };
  }, [open, ref, close]);
}

export function useDropdown(): DropdownControls {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  useDropdownDismissal(open, ref, close);

  return {
    open,
    toggle,
    close,
    ref,
  };
}
