# Web UI — visual design

Implemented in `ui/` (React + TypeScript + Vite). This describes the visual design for the local web reader: three screens — Unlock, Library, Reader — built on Bootstrap (both CSS and its icon set). It covers layout and appearance only; see [docs/data_model.md](data_model.md)/[docs/credentials.md](credentials.md) for the underlying schema and credential model this UI reads from.

## Look and feel

Mostly stock Bootstrap: default components (`navbar`, `list-group`, `progress`, `input-group`, `badge`, `btn`), default system-font stack, default light/dark theming. The one deliberate brand touch is the primary accent — a brass/gold tone (lighter and more saturated in dark mode, darker and more muted in light mode) — set via Bootstrap's own theme-color variables so every component that already references the primary color (buttons, progress bars, links, the active nav item) picks it up automatically, in both themes, with no per-component overrides needed.

No cover art anywhere — the vault only ever holds text, so titles and author names carry the visual weight instead of a thumbnail grid.

The browser tab's favicon (`ui/leancrypto/favicon.svg` — that directory is Vite's `publicDir`, see `vite.config.ts`) reuses Bootstrap Icons' `book` glyph, the same one in the wordmark, recolored to the brass/gold accent.

## Screen 1 — Unlock

The only job here is loading the credential file. No headline, no explanatory copy, no dropzone preview — a wordmark and a single button.

```
┌────────────────────────────────────────────────┐
│                                                │
│                                                │
│               [library]  Skypiea               │
│                                                │
│            ┌──────────────────────┐            │
│            │ [file]  Choose File  │            │
│            │         to unlock    │            │
│            │         your library │            │
│            └──────────────────────┘            │
│                                                │
│                                                │
└────────────────────────────────────────────────┘
```

- Centered column, vertically and horizontally, independent of screen size.
- The button carries both the action ("Choose File") and its effect ("to unlock your library") as a two-line label, so no separate sentence of instruction is needed above it.
- While unlocking, a small spinner and a "Setting up your library…" line appear under the button — the Library screen isn't shown until the vault is fully ready (metadata, read positions, and bookmarks all loaded), not just as soon as the password checks out.

## Screen 2 — Library

Two panes: a catalog nav on the left, a plain list of books on the right — no card grid, no cover thumbnails or monogram tiles.

```
┌────────────────────────────────────────────────────────────────────┐
│   [library] Skypiea   [search  Search your library]   [Unlocked]   │
├────────────────┬───────────────────────────────────────────────────┤
│ ● Recent    2  │ Recent                            2 in progress   │
│ All books  10  │───────────────────────────────────────────────────│
│                │ CONTINUE READING                                  │
│ BROWSE         │───────────────────────────────────────────────────│
│ Authors     9  │ 21 Lessons for the 21st Century               [x]│
│ Subjects   14  │ Yuval Noah Harari · History, Anthropology         │
│ Publishers  9  │───────────────────────────────────────────────────│
│                │ The White Order                               [x]│
│                │ L. E. Modesitt, Jr. · Fantasy, Military           │
│                │───────────────────────────────────────────────────│
│                │ RECENT BOOKMARKS                                  │
│                │───────────────────────────────────────────────────│
│                │ [bk] The White Order      Part 14 · Line 1   [x]  │
│                │      "Powerful white mages killed..."             │
└────────────────┴───────────────────────────────────────────────────┘
```

- **Left nav**: Recent and All books as the two primary views, each with a count; a Browse group below for Authors / Subjects / Publishers, each also with a count. Recent is the default landing view. Below the `lg` breakpoint there's no room for it beside the book list, so it collapses into a dropdown instead — merged into the wordmark itself (clicking it opens/closes the dropdown, rather than a separate icon button next to it), closed by default, closing again on a selection, an outside click, or Escape, same as the Reader screen's dropdowns.
- **Right pane, All books/Browse views**: one row per book, two lines each — title on top, then `Author · Subject, Subject · Publisher` underneath. In-progress books show "Part N" at the right edge (the Library screen doesn't fetch a total part count — see the Reader screen for that — so there's no fraction or progress bar here, and no "Finished" state either); unstarted books show nothing there.
- **Right pane, Recent view**: two stacked sections instead of a single list. "Continue Reading" is the book-row list above, most recently opened first — unlike the All books/Browse rows, it doesn't show a part number at all (this view is already scoped to "in progress", so it'd be redundant). "Recent Bookmarks" below it flattens every bookmark across every book, most recently created first, each row showing the book title, `Part N · Line M`, and a short preview of that line's text — clicking one opens the reader at that spot. Every row in both sections carries a small delete ("x") button that removes just that entry (forgetting a book's read position, or discarding a bookmark) without deleting the book itself.
- Top bar stays a slim strip above both panes: wordmark, a search field, and a status pill confirming the vault is unlocked.

## Screen 3 — Reader

A full-width reading pane with a part-navigation bar along the bottom. "About this book" and "Bookmarks" aren't a persistent side panel — each is its own dropdown, closed by default: Info hangs off the top bar (opens downward), Bookmarks off the bottom bar (opens upward, since it's anchored near the bottom of the screen).

```
┌────────────────────────────────────────────────────────────────────┐
│ [<]   The White Order                                        [i]   │
│       L. E. Modesitt, Jr.                                          │
├────────────────────────────────────────────────────────────────────┤
│ PART 14 OF 41                                                      │
│                                                                     │
│ The White Order                                                    │
│                                                                     │
│[bk] Powerful white mages killed Cerryl's father to protect their    │
│    control of the world's magic. Raised by his aunt and uncle,      │
│    Cerryl learns that he has inherited his father's magic           │
│    abilities...                                                     │
│                                                                     │
│[bk] When Cerryl witnesses a white mage destroy a renegade            │
│    magician in the market square, he understands, all at once       │
│    and far too late, exactly what he is.                            │
├────────────────────────────────────────────────────────────────────┤
│ [<]  [14]/ 41  [>]                                          [bk]    │
└────────────────────────────────────────────────────────────────────┘
```

- **Top bar**: an icon-only back-to-library button (no label), the current book's title/author, and the Info button (toggles its dropdown, closed by default; closes on an outside click or Escape). Below the `sm` breakpoint the author drops to its own second line instead of sharing one with the title — no room for both there. Left/right padding shrinks below `sm` too, giving a narrow screen back a bit more usable width.
- **Reading column**: comfortable line length, one part's text at a time — no chapter/whole-document view, always full width (there's no side panel competing for space). Each line has its own bookmark icon in the left gutter, only visible on hover/focus unless that line is already bookmarked (then it stays visible as a status indicator), filled in once bookmarked; there's no separate "bookmark this part" control.
- **Info dropdown**: title, author, series if any, subject tags, and a short description pulled from the book's catalog metadata. A description longer than 200 characters shows truncated with an ellipsis and a "Show more"/"Show less" toggle rather than the full text up front.
- **Bottom bar**: Previous/Next are icon-only chevrons (no text label, at any screen size), flanking an editable part-number box (up to 3 digits — typing a number and pressing Enter or clicking away jumps there, clamped to the book's actual range) followed by `/ <total>`. No progress bar here. The Bookmarks button sits at the far right of the bar on its own. Bookmarks lists entries most recent first by `created_at`, each showing which part and line plus a short preview of that line's text; clicking one jumps to that exact line (scrolling to it and briefly highlighting it), not just its part. Each bookmark carries a small delete ("x") button that removes just that one, the same affordance as the Library's Recent Bookmarks rows.
