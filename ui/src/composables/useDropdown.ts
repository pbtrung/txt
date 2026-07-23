// Shared behavior behind every hand-rolled dropdown in this app (Library's
// nav drawer, Reader's Info and Bookmarks menus): there's no Bootstrap JS in
// this project (only its CSS), so open/closed state and "close on an outside
// click or Escape" are all hand-rolled here instead of relying on its
// dropdown plugin. Each call is independent -- two dropdowns that should
// close each other out (e.g. Reader's Info/Bookmarks) do that by having their
// owning screen call one's `close()` from the other's toggle, not by sharing
// state here.

import { onUnmounted, ref, watch, type Ref } from "vue";

export interface DropdownControls {
  open: Ref<boolean>;
  toggle: () => void;
  close: () => void;
  /** Attach to the dropdown's wrapper element (the one containing both the
   * toggle button and the menu) -- an outside click is anything outside it. */
  ref: Ref<HTMLElement | null>;
}

export function useDropdown(): DropdownControls {
  const open = ref(false);
  const wrapperRef = ref<HTMLElement | null>(null);

  let stopListening: (() => void) | null = null;

  // flush: "sync" -- these attach/detach a *global document* listener, so it
  // should happen the instant `open` changes, not on Vue's default batched
  // (microtask-deferred) schedule.
  watch(
    open,
    (isOpen) => {
      stopListening?.();
      stopListening = null;
      if (!isOpen) return;

      function handlePointerDown(event: MouseEvent) {
        if (wrapperRef.value && !wrapperRef.value.contains(event.target as Node)) {
          open.value = false;
        }
      }
      function handleKeyDown(event: KeyboardEvent) {
        if (event.key === "Escape") open.value = false;
      }
      document.addEventListener("mousedown", handlePointerDown);
      document.addEventListener("keydown", handleKeyDown);
      stopListening = () => {
        document.removeEventListener("mousedown", handlePointerDown);
        document.removeEventListener("keydown", handleKeyDown);
      };
    },
    { flush: "sync" },
  );

  onUnmounted(() => stopListening?.());

  return {
    open,
    toggle: () => {
      open.value = !open.value;
    },
    close: () => {
      open.value = false;
    },
    ref: wrapperRef,
  };
}
