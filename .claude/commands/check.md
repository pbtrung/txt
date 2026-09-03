---
description: Run the full lint/format/typecheck/build/test suite without staging, committing, or pushing anything
---

# Check

Runs every check from README.md's "Development checks" section, in the
same order, exactly as documented there — a single "is the repo green"
signal, decoupled from staging or committing anything.

## Steps

1. `python3 -m pytest`
2. `python3 -m ruff check .`
3. `python3 -m ruff format --check .`
4. `npm run ui:test`
5. `npm run ui:typecheck`
6. `npm run worker:test`
7. `npm run worker:typecheck`
8. `npm run lint`
9. `npm run format:check`
10. `npm run ui:build`
11. Report a pass/fail summary for all ten steps. On the first failure,
    stop and show its actual output rather than continuing through later
    steps once the tree state around it is unclear — a formatting or type
    error can cascade into unrelated-looking failures downstream.

## Rules

- Every command above is read-only or check-mode (`ruff format --check`,
  `prettier --check` via `format:check`) — none of them may rewrite a
  file. If a step would normally auto-fix (e.g. `ruff format .` without
  `--check`, or `prettier --write` via `npm run format`), use the
  check-only variant here instead; leave writing fixes to `/commit` or to
  fixing the reported issue by hand.
- Never run these commands against `sqlcipher/` (vendored/generated,
  already excluded by config) — don't widen a glob or pass an explicit
  path that would pull it in.
- Do not stage, commit, or push anything.
- If a check fails, report it and stop; only fix the underlying issue if
  the user asks you to.
