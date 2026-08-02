// Thin factory around @instantdb/react's init() -- kept as its own module
// (rather than a module-level singleton db instance, the pattern InstantDB's
// own docs show) so tests can construct an independent client per test
// instead of sharing one global instance across the whole suite. Schema-less
// on purpose: instant.schema.ts (repo root) types @instantdb/core for the
// CLI's own admin-SDK usage, but pulling it into ui/'s separate tsconfig
// project just for autocomplete isn't worth the cross-project include
// wiring -- every query in this app's data layer is untyped `db.query`,
// same as the rest of this codebase's `db: any` convention (adminInit.ts,
// remotePageStore.ts, migrate.ts).
import { init } from "@instantdb/react";

export function createInstantClient(appId: string) {
  return init({ appId });
}
