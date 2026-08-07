// Thin factory around @instantdb/react's init() -- kept as its own module
// (rather than a module-level singleton db instance, the pattern InstantDB's
// own docs show) so tests can construct an independent client per test
// instead of sharing one global instance across the whole suite. Schema-less
// on purpose: instant.schema.ts (repo root) is the InstantDB schema pushed
// against the real app, not a TypeScript type import anything in this repo
// actually uses -- pulling it into ui/'s separate tsconfig project just for
// autocomplete isn't worth the cross-project include wiring -- every query in
// this app's data layer is untyped `db.query`, same as the rest of this
// codebase's `db: any` convention (adminInit.ts, ingest.ts). This factory is
// browser-only. The R2 credential Worker intentionally never initializes or
// queries InstantDB (docs/r2_credentials.md).
import { init } from "@instantdb/react";

export function createInstantClient(appId: string) {
  // devtool: false -- InstantDB's own floating dev-tool button (bottom-right
  // by default) is not something this app's own UI wants.
  return init({ appId, devtool: false });
}
