<script setup lang="ts">
import LibraryNavItem from "./LibraryNavItem.vue";
import type { BrowseDimension, BrowseEntry } from "./libraryModel";

// Duplicated from LibraryScreen.vue rather than exported from
// libraryModel.ts -- keeping libraryModel.ts untouched avoids any risk to
// the not-yet-migrated LibraryScreen.tsx, which still defines this same
// type locally too.
export type View =
  | { kind: "recent" }
  | { kind: "all" }
  | { kind: "browse"; dimension: BrowseDimension }
  | { kind: "browseValue"; dimension: BrowseDimension; value: string };

defineProps<{
  view: View;
  selectView: (next: View) => void;
  recentCount: number;
  allCount: number;
  authorEntries: BrowseEntry[];
  subjectEntries: BrowseEntry[];
  publisherEntries: BrowseEntry[];
  displayName: string | undefined;
  onLock: () => void;
}>();
</script>

<template>
  <div class="flex-grow-1 overflow-auto">
    <div class="list-group list-group-flush">
      <LibraryNavItem
        :active="view.kind === 'recent'"
        label="Recent"
        :count="recentCount"
        :onClick="() => selectView({ kind: 'recent' })"
      />
      <LibraryNavItem
        :active="view.kind === 'all'"
        label="All books"
        :count="allCount"
        :onClick="() => selectView({ kind: 'all' })"
      />
    </div>
    <div class="text-body-secondary small fw-semibold text-uppercase mt-3 mb-1 px-2">Browse</div>
    <div class="list-group list-group-flush">
      <LibraryNavItem
        :active="view.kind === 'browse' && view.dimension === 'author'"
        label="Authors"
        :count="authorEntries.length"
        :onClick="() => selectView({ kind: 'browse', dimension: 'author' })"
      />
      <LibraryNavItem
        :active="view.kind === 'browse' && view.dimension === 'subject'"
        label="Subjects"
        :count="subjectEntries.length"
        :onClick="() => selectView({ kind: 'browse', dimension: 'subject' })"
      />
      <LibraryNavItem
        :active="view.kind === 'browse' && view.dimension === 'publisher'"
        label="Publishers"
        :count="publisherEntries.length"
        :onClick="() => selectView({ kind: 'browse', dimension: 'publisher' })"
      />
    </div>
  </div>

  <!-- The account footer: who's signed in, and the (now icon-only) Lock
       action -- moved here from the top bar so it's part of "your account"
       rather than sitting next to the search field. -->
  <div class="border-top pt-2 mt-2 d-flex align-items-center justify-content-between gap-2">
    <span class="d-flex align-items-center gap-2 text-truncate">
      <i class="bi bi-person-circle text-body-secondary flex-shrink-0" aria-hidden="true" />
      <span class="small text-body-secondary text-truncate">{{ displayName }}</span>
    </span>
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary border-primary flex-shrink-0"
      @click="onLock"
      aria-label="Lock"
      title="Lock"
    >
      <i class="bi bi-unlock text-primary" aria-hidden="true" />
    </button>
  </div>
</template>
