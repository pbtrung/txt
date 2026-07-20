# Web UI — visual design

Implemented in `ui/` (React + TypeScript + Vite). This describes the visual design for the local web reader: three screens — Unlock, Library, Reader — built on Bootstrap (both CSS and its icon set). It covers layout and appearance only; see [docs/data_model.md](data_model.md)/[docs/credentials.md](credentials.md) for the underlying schema and credential model this UI reads from.

## Look and feel

Mostly stock Bootstrap: default components (`navbar`, `list-group`, `progress`, `input-group`, `badge`, `btn`), default system-font stack, default light/dark theming. The one deliberate brand touch is the primary accent — a brass/gold tone (lighter and more saturated in dark mode, darker and more muted in light mode) — set via Bootstrap's own theme-color variables so every component that already references the primary color (buttons, progress bars, links, the active nav item) picks it up automatically, in both themes, with no per-component overrides needed.

No cover art anywhere — the vault only ever holds text, so titles and author names carry the visual weight instead of a thumbnail grid.

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

## Screen 2 — Library

Two panes: a catalog nav on the left, a plain list of books on the right — no card grid, no cover thumbnails or monogram tiles.

```
┌────────────────────────────────────────────────────────────────────┐
│   [library] Skypiea   [search  Search your library]   [Unlocked]   │
├────────────────┬───────────────────────────────────────────────────┤
│ ● Recent    3  │ Recent                            3 in progress   │
│ All books  10  │───────────────────────────────────────────────────│
│                │ 21 Lessons for the 21st Century     Part 18/29    │
│ BROWSE         │ Yuval Noah Harari · History, Anthropology ·       │
│ Authors     9  │ Random House Publishing Group      [======    ]   │
│ Subjects   14  │───────────────────────────────────────────────────│
│ Publishers  9  │ The White Order                     Part 14/41    │
│                │ L. E. Modesitt, Jr. · Fantasy, Military ·         │
│                │ Tor Publishing Group               [====      ]   │
│                │───────────────────────────────────────────────────│
│                │ Unshrinking: How to Face Fatphobia   Part 2/22    │
│                │ Kate Manne · Social Science · Crown [=         ]  │
└────────────────┴───────────────────────────────────────────────────┘
```

- **Left nav**: Recent and All books as the two primary views, each with a count; a Browse group below for Authors / Subjects / Publishers, each also with a count. Recent is the default landing view.
- **Right pane**: one row per book, two lines each — title on top, then `Author · Subject, Subject · Publisher` underneath. A trailing progress bar and part-count sit at the right edge of in-progress rows; unstarted books show a part count instead, finished ones show "Finished."
- Top bar stays a slim strip above both panes: wordmark, a search field, and a status pill confirming the vault is unlocked.

## Screen 3 — Reader

Reading pane on the left, a slim metadata/bookmarks panel on the right, a part-navigation bar along the bottom.

```
┌────────────────────────────────────────────────────────────────────┐
│ [<] Library   The White Order / L. E. Modesitt, Jr.        [i]     │
├───────────────────────────────────────────────┬────────────────────┤
│ PART 14 OF 41                                 │ ABOUT THIS BOOK    │
│                                               │ The White Order    │
│ The White Order                               │ L. E. Modesitt, Jr.│
│                                               │ Saga of Recluce, #8│
│[bk] Powerful white mages killed Cerryl's      │                    │
│    father to protect their control of the     │ [Fantasy][Mil.]    │
│    world's magic. Raised by his aunt and      │ "...continues his  │
│    uncle, Cerryl learns that he has           │ bestselling fantasy│
│    inherited his father's magic abilities...  │ series"            │
│                                               │                    │
│[bk] When Cerryl witnesses a white mage        │ BOOKMARKS          │
│    destroy a renegade magician in the         │ [bk] Part 14·Line 1│
│    market square, he understands, all at      │  "Powerful white   │
│    once and far too late, exactly what he is. │   mages killed..." │
│                                               │ [bk] Part 8·Line 3 │
│                                               │  "He knew that the │
│                                               │   white robes..."  │
├───────────────────────────────────────────────┴────────────────────┤
│ [< Previous]   Part 14 / 41  [========            ]  [Next >]      │
└────────────────────────────────────────────────────────────────────┘
```

- **Top bar**: back-to-library, the current book's title/author, and a single toggleable icon button that opens the "About this book" panel (shown active/open here so the panel's content is visible in the design).
- **Reading column**: comfortable line length, one part's text at a time — no chapter/whole-document view. Each line has its own bookmark icon in the left gutter, filled in once bookmarked; there's no separate "bookmark this part" control.
- **Side panel**: "About this book" (title, author, series if any, subject tags, a short description pulled from the book's catalog metadata) above "Bookmarks" (most recent first — bookmarks carry no timestamp, so this is insertion order — each showing which part and line, plus a short preview of that line's text; clicking one jumps to that part).
- **Bottom bar**: Previous/Next, the current part out of the total, and a slim progress track — the same progress indicator style used in the Library list, so a book's position reads consistently in both places.
