---
description: Audit docs/*.md, README.md, and CLAUDE.md for internal consistency, drift against the code, and stale/historical references
---

# Audit Docs

Cross-checks this repo's documentation against itself and against the
actual code, catching the two failure modes docs accumulate over time:
drift (a doc claim that no longer matches the code) and staleness (a
reference to something removed, renamed, or historical that has no place
in a doc describing the current, finished system).

## Scope

`docs/auth.md`, `docs/crypto.md`, `docs/data_model.md`,
`docs/deployment.md`, `docs/sharing.md`, `docs/storage_layout.md`,
`README.md`, `CLAUDE.md`.

## Steps

1. Read every file in scope in full.
2. Structural accuracy: run `find worker txt/*.py ui/src -type f` and
   confirm CLAUDE.md's "Code layout" section lists every file that
   actually exists, with no stale/removed entries and nothing missing.
3. Cross-doc consistency: confirm shared concepts agree everywhere they're
   described — the owner binding ticket and proof-of-possession
   (auth.md/data_model.md), the `db_prefix`/R2 key layout
   (storage_layout.md/sharing.md), the `shares` state machine
   (sharing.md/data_model.md), and which endpoints require ticket+proof
   vs. Access-only vs. neither (auth.md/sharing.md/data_model.md). Flag
   any contradiction with both file:line locations.
4. Doc-to-code spot checks: for a sample of specific, checkable claims in
   each doc (a named env var, a named D1 table/column, a named R2 prefix,
   a status code, a function name), grep or read the actual source under
   `worker/`, `txt/`, or `ui/src/` to confirm it still exists and behaves
   as described. This is a spot-check, not a full line-by-line code
   review — don't try to re-derive correctness of the implementation
   itself here.
5. Stale/historical references: this repo documents one finished, current
   design — flag any reference to a prior design, a superseded tech
   stack, a removed dependency, or narrated development history (no
   commit hashes, no "previously", no "legacy", no "used to be", no
   milestone/build-order narration) in any file in scope.
6. README accuracy: confirm the commands, setup steps, and file
   references in `README.md` match `package.json` scripts, `cli.py`'s
   actual commands, and `wrangler.jsonc`.
7. Report every finding with file:line, a one-line description, and
   whether it's safe to fix mechanically (a stale reference, a broken
   cross-reference, a dead link) versus a project-level judgment call (a
   real design contradiction, a decision about what a doc should say).
   Do not edit anything yet.
8. Ask the user which findings to act on, then apply only those fixes.

## Rules

- Read-only until step 8's explicit go-ahead — this command reports
  findings, it doesn't refactor docs on its own initiative.
- Don't attempt a full correctness audit of `worker/`, `txt/`, or
  `ui/src/` itself in this pass — that's a separate, much larger job; this
  command is about the documentation layer.
- A finding needs a concrete file:line, not a vague impression — if you
  can't point to the exact location, it's not a finding yet.
