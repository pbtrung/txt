// Thin factory around @instantdb/react's init() -- kept as its own module
// (rather than a module-level singleton db instance, the pattern InstantDB's
// own docs show) so tests can construct an independent client per test
// instead of sharing one global instance across the whole suite. Schema-less
// on purpose: instant.schema.ts (repo root) is the InstantDB schema pushed
// against the real app, not a TypeScript type import anything in this repo
// actually uses -- pulling it into ui/'s separate tsconfig project just for
// autocomplete isn't worth the cross-project include wiring -- every query in
// this app's data layer is untyped `db.query`, same as the rest of this
// codebase's `db: any` convention (adminInit.ts, remotePageStore.ts,
// migrate.ts).
//
// shimWindowForWorker() below works around a real gap in @instantdb/core's
// own feature detection: its Reactor constructor gates *all* real
// initialization behind `isClient()` (typeof window !== 'undefined' ||
// typeof chrome !== 'undefined'), silently skipping _initStorage() et al
// when that's false and later crashing deep inside signInWithIdToken() with
// "Cannot read properties of undefined (reading 'updateInPlace')" -- the
// exact failure this project already hit once running the Reactor under
// Node (see instantSignIn.ts's header comment). This app has no Worker of
// its own right now, but the shim stays in place in case one is ever
// reintroduced -- a Worker's global scope is `self`, no `window`, so
// createInstantClient() called from inside one would hit the exact same
// gate for the exact same reason, even though everything the Reactor
// actually *uses* -- WebSocket, IndexedDB, BroadcastChannel,
// navigator.onLine, addEventListener -- is genuinely available in a
// dedicated Worker. Confirmed by reading @instantdb/core's own source that
// every other window/document reference lives behind its own separate
// `typeof window.location`/`typeof document` guard (OAuth-redirect-specific
// code this app never exercises, since it only ever calls
// signInWithIdToken, never a redirect flow) -- so faking just enough of
// `window` to pass isClient() still leaves those safely no-op-ing. The
// current R2 credential Worker intentionally does not use InstantDB; this
// shim is for any future Worker-side InstantDB client code.
import { init } from "@instantdb/react";

function shimWindowForWorker(): void {
  // globalThis.self, not the bare `self` identifier -- Node (this module's
  // test environment) never declares `self` as an identifier at all, so
  // referencing it directly throws ReferenceError there; a real dedicated
  // Worker always has `self` (it's the Worker's own global scope), so
  // globalThis.self resolves the same value there regardless.
  const g = globalThis as {
    window?: unknown;
    self?: unknown;
    WorkerGlobalScope?: unknown;
  };
  if (typeof g.window !== "undefined") return; // real browser main thread
  if (typeof g.WorkerGlobalScope === "undefined") return; // not a Worker either
  g.window = g.self;
}

export function createInstantClient(appId: string) {
  shimWindowForWorker();
  // devtool: false -- InstantDB's own floating dev-tool button (bottom-right
  // by default), only ever a main-thread thing in practice (handleDevtool
  // no-ops without a real `document`, so the Worker-side shimWindowForWorker()
  // call above never triggers it) but not something this app's own UI wants.
  return init({ appId, devtool: false });
}
