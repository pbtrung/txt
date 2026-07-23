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
//
// A first attempt at the empirical check used replaceState(state, "",
// location.href) as the no-op probe -- but that's an *absolute* URL, so the
// browser resolves it as-is without ever consulting document.baseURI, and
// comparing an opaque origin to itself this way turns out not to throw
// (confirmed empirically) even when a *relative* URL -- what react-router
// actually passes -- absolutely would. That's exactly local_index.html's
// case: render.ts points <base> at asset_base_url (a real http(s) origin)
// before this ever runs, so a same-origin-as-itself absolute-URL probe
// passed, wrongly picking BrowserRouter, which then threw for real on its
// first actual (relative-path) navigation. Using a path-absolute string
// instead (pathname+search+hash, no scheme/host of its own) forces
// resolution through document.baseURI the same way react-router's own
// calls do, so it fails exactly when they would -- and it's still a true
// no-op on a normal deployment (no <base> override means resolving
// pathname+search+hash against document.baseURI reproduces location.href
// exactly, confirmed empirically: location before and after are identical).
import type { ComponentType, ReactNode } from "react";
import { BrowserRouter, MemoryRouter } from "react-router-dom";

function historyApiUsable(): boolean {
  try {
    window.history.replaceState(window.history.state, "", location.pathname + location.search + location.hash);
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
