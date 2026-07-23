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
// MemoryRouter manages navigation entirely in JS, never touching
// window.history/window.location, so it's the only router that works
// there. Tradeoff, accepted as the cost of local_index.html's file://
// bootstrap: the address bar won't reflect in-app navigation, and browser
// back/forward won't move between screens.
import type { ComponentType, ReactNode } from "react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";

export function pickRouterComponent(protocol: string): ComponentType<{ children?: ReactNode }> {
  return protocol === "file:" ? MemoryRouter : BrowserRouter;
}
