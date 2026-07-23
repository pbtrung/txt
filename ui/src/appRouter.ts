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
// Checked via location.origin (an opaque origin always serializes to the
// literal string "null"), not location.protocol === "file:" -- Android in
// particular commonly opens a local file through a content:// URI instead
// of file:// (e.g. a file manager's "Open with Chrome"), which is just as
// opaque-origin as file:// but wouldn't match a protocol-based check,
// hitting this exact SecurityError. Checking the origin directly catches
// file://, content://, and any other scheme that ends up opaque, without
// needing to enumerate them.
//
// MemoryRouter manages navigation entirely in JS, never touching
// window.history/window.location, so it's the only router that works
// there. Tradeoff, accepted as the cost of local_index.html's opaque-origin
// bootstrap: the address bar won't reflect in-app navigation, and browser
// back/forward won't move between screens.
import type { ComponentType, ReactNode } from "react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";

export function pickRouterComponent(origin: string): ComponentType<{ children?: ReactNode }> {
  return origin === "null" ? MemoryRouter : BrowserRouter;
}
