// vue-router setup: which History implementation to mount under, and the
// guard that keeps /library and /read/:txtId behind an unlocked vault
// session. The actual createRouter({ routes }) call (needing the real
// screen components) is assembled once they exist -- see App.vue.

import { createMemoryHistory, createWebHistory, type RouterHistory } from "vue-router";

import { useVault } from "./state/vault";

// history.pushState()/replaceState() (which createWebHistory() needs for
// every navigation) throws a SecurityError in a document with an opaque/
// null origin -- per the History API spec, "cannot be created in a
// document with origin 'null'", regardless of what URL is passed. That's
// exactly local_index.html's situation when opened via file:// (see
// ui/src/localIndex/): the real app's own bundle runs unmodified inside it,
// so this has to be handled in the app itself, not in the verifier.
//
// createMemoryHistory() manages navigation entirely in JS, never touching
// window.history/window.location, so it's the only one that works there.
// Tradeoff, accepted as the cost of local_index.html's file:// bootstrap:
// the address bar won't reflect in-app navigation, and browser back/forward
// won't move between screens. Ported verbatim (same reasoning, same check)
// from the old appRouter.ts's pickRouterComponent.
export function pickRouterHistory(protocol: string): RouterHistory {
  return protocol === "file:" ? createMemoryHistory() : createWebHistory();
}

// Replaces RequireUnlocked.tsx's wrapper-component pattern: a plain
// beforeEach guard is more idiomatic in vue-router, and only works at all
// because useVault() is a plain importable singleton rather than a React
// context -- a guard runs outside any component's setup(), so there'd be
// nothing to inject from otherwise. Split out as a pure predicate (path in,
// boolean out) so it's directly unit-testable without a real router/vault
// instance; the guard itself (wired up once real routes exist) just calls
// this and useVault().status.
export function requiresUnlockedSession(path: string): boolean {
  return path === "/library" || path.startsWith("/read/");
}

/** The redirect target a navigation guard should return for `to.path`, or
 * undefined to let the navigation proceed unchanged. */
export function guardRedirect(path: string): string | undefined {
  if (requiresUnlockedSession(path) && useVault().status.value !== "unlocked") {
    return "/";
  }
  return undefined;
}
