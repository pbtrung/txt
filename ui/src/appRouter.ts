// Picks which react-router-dom Router App.tsx mounts under.
//
// history.pushState()/replaceState() (which BrowserRouter needs for every
// navigation) throws a SecurityError in a document with an opaque/null
// origin -- per the History API spec, "cannot be created in a document
// with origin 'null'", regardless of what URL is passed. That's exactly
// local_index.html's situation when opened via file:// (see
// ui/src/localIndex/): the real app's own bundle runs unmodified inside it,
// so this has to be handled in the app itself, not in the verifier.
//
// Detected empirically -- actually attempting a no-op replaceState() and
// checking whether it throws -- rather than by inspecting
// location.protocol/location.origin. Two prior attempts at guessing this
// from a string turned out not to be reliable enough: `protocol === "file:"`
// missed Android, which commonly opens a local file through a content://
// URI instead (e.g. a file manager's "Open with Chrome") -- just as
// opaque-origin as file://, but a different protocol string. Then
// `origin === "null"` *also* didn't catch it in practice (confirmed against
// a real Android device, still throwing "cannot be created in a document
// with origin 'null'" after that fix shipped) -- Chrome-on-Android's
// location.origin for a content:// document apparently doesn't reliably
// serialize to the literal string "null" the way file://'s does, even
// though the browser's own error message describes the origin as opaque.
// Trying the actual operation and catching the failure sidesteps needing to
// know how any given browser/scheme/platform combination happens to report
// its origin -- it can't be fooled by a serialization quirk, because it's
// not inspecting a serialization at all.
import type { ComponentType, ReactNode } from "react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";

function historyApiUsable(): boolean {
  try {
    // A same-URL, same-state no-op: harmless on a working origin (doesn't
    // add an entry, doesn't fire popstate, doesn't touch the visible URL --
    // it's already exactly this), but throws immediately on an opaque one,
    // per the same SecurityError this function exists to detect in advance.
    window.history.replaceState(window.history.state, "", location.href);
    return true;
  } catch {
    return false;
  }
}

// MemoryRouter manages navigation entirely in JS, never touching
// window.history/window.location, so it's the only router that works in
// an opaque-origin document. Tradeoff, accepted as the cost of
// local_index.html's opaque-origin bootstrap: the address bar won't
// reflect in-app navigation, and browser back/forward won't move between
// screens.
export function pickRouterComponent(): ComponentType<{ children?: ReactNode }> {
  return historyApiUsable() ? BrowserRouter : MemoryRouter;
}
