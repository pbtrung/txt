<script setup lang="ts">
// Screen 2 -- Library (docs/ui.md): a catalog nav on the left, a plain list
// of books on the right. Top bar stays a slim strip above both panes:
// wordmark and a search field. Account status/actions (who's signed in, and
// locking the vault) live in the nav's account footer instead, not the top
// bar.
//
// Below lg, the nav has no room to sit beside the book list, so its content
// (LibraryNavContent) is shared between two renderings instead of
// duplicated: a persistent lg+ sidebar, and a dropdown below lg -- toggled
// by the book icon alone (not the full wordmark) rather than a separate
// hamburger button next to it.

import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import BookmarkRow from "../../components/BookmarkRow.vue";
import BookRow from "../../components/BookRow.vue";
import DropdownToggleButton from "../../components/DropdownToggleButton.vue";
import Wordmark from "../../components/Wordmark.vue";
import { useDropdown } from "../../composables/useDropdown";
import { useVault } from "../../state/vault";
import {
  allBooksSorted,
  browseEntries,
  booksForDimensionValue,
  matchesSearch,
  recentBookmarks,
  recentBooks,
  type BrowseDimension,
  type LibraryBook,
  type RecentBookmarkItem,
} from "./libraryModel";
import { useLibraryBooks } from "./useLibraryBooks";
import LibraryNavContent, { type View } from "./LibraryNavContent.vue";

const DIMENSION_LABEL: Record<BrowseDimension, string> = {
  author: "Authors",
  subject: "Subjects",
  publisher: "Publishers",
};

const { lock, session, bookmarksMap, removeAccessEntry, removeBookmarkEntry } = useVault();
const router = useRouter();
const { books, loading } = useLibraryBooks();
const view = ref<View>({ kind: "recent" });
const search = ref("");
// Below the lg breakpoint the left nav collapses into the wordmark's
// dropdown; picking anything in it closes it again so the chosen view
// actually comes into view.
const nav = useDropdown();

function selectView(next: View): void {
  view.value = next;
  nav.close();
}

const authorEntries = computed(() => browseEntries(books.value ?? [], "author"));
const subjectEntries = computed(() => browseEntries(books.value ?? [], "subject"));
const publisherEntries = computed(() => browseEntries(books.value ?? [], "publisher"));
const recent = computed(() => recentBooks(books.value ?? []));
// Search only filters Continue Reading -- Recent Bookmarks isn't searchable.
const continueReading = computed(() =>
  search.value.trim() ? recent.value.filter((b) => matchesSearch(b, search.value)) : recent.value,
);
const metadataById = computed(() => new Map((books.value ?? []).map((b) => [b.txtId, b.info])));
const recentBookmarkItems = computed(() => recentBookmarks(bookmarksMap.value, metadataById.value));

function openBook(book: LibraryBook): void {
  router.push(`/read/${book.txtId}`);
}

function openBookmark(item: RecentBookmarkItem): void {
  router.push(`/read/${item.txtId}?part=${item.partNum}&line=${item.line}`);
}

// Mirrors LibraryScreen.tsx's own sequential if/else derivation exactly:
// first pick heading/headingDetail/bookList/browseList from `view`, then --
// only when bookList is a real list -- apply the search filter and
// recompute headingDetail from what's actually left, so the header's count
// never shows the pre-search total.
const viewData = computed(() => {
  const v = view.value;
  const allBooks = books.value ?? [];
  let heading: string;
  let headingDetail: string;
  let bookList: LibraryBook[] | null = null;
  let browseList: { value: string; count: number }[] | null = null;

  if (v.kind === "recent") {
    heading = "Recent";
    // Every entry here has lastPartNum set (recentBooks() only includes
    // books with a lastAccessedMs, and the two are always set together --
    // see libraryModel.ts's buildLibraryBooks), so this is just its count.
    headingDetail = `${recent.value.length} in progress`;
  } else if (v.kind === "all") {
    const all = allBooksSorted(allBooks);
    heading = "All books";
    headingDetail = `${all.length} book${all.length === 1 ? "" : "s"}`;
    bookList = all;
  } else if (v.kind === "browse") {
    const entries = { author: authorEntries.value, subject: subjectEntries.value, publisher: publisherEntries.value }[
      v.dimension
    ];
    heading = DIMENSION_LABEL[v.dimension];
    headingDetail = `${entries.length}`;
    browseList = entries;
  } else {
    const filtered = booksForDimensionValue(allBooks, v.dimension, v.value);
    heading = v.value;
    headingDetail = `${filtered.length} book${filtered.length === 1 ? "" : "s"}`;
    bookList = filtered;
  }

  if (bookList && search.value.trim()) {
    bookList = bookList.filter((b) => matchesSearch(b, search.value));
    headingDetail = `${bookList.length} book${bookList.length === 1 ? "" : "s"}`;
  }

  return { heading, headingDetail, bookList, browseList };
});
</script>

<template>
  <div class="shell-60 d-flex flex-column vh-100">
    <!-- flex-nowrap, not flex-wrap: flexbox decides line breaks from each
         item's *hypothetical* (unshrunk) main size, not its post-shrink
         size -- so even with minWidth:0 below letting the content cell
         shrink, a wrapping container could still push it to a second line
         at viewport widths where its natural (un-shrunk) size doesn't fit
         next to the drawer toggle, before shrinking ever gets a chance to
         apply. Forcing one line makes that shrinking actually take effect,
         keeping the toggle and search box together at every width instead
         of wrapping at some in-between range. -->
    <div class="border-bottom d-flex flex-nowrap align-items-stretch">
      <!-- lg+: a fixed-width cell -- same class (and width) as the sidebar
           below -- so the content cell beside it starts at the same x as
           the right pane's own content, and its border-end continues the
           sidebar's vertical rule upward into the top bar. -->
      <div class="library-nav border-end p-2 d-none d-lg-flex align-items-center justify-content-center">
        <Wordmark />
      </div>

      <!-- Below lg: the book icon alone (not the "Skypiea" text) is the
           drawer toggle -- styled as a visible bordered button so it reads
           as tappable; the wordmark text sits beside it, plain, but is
           dropped below sm entirely. -->
      <div
        :ref="(el) => (nav.ref.value = el as HTMLElement | null)"
        class="dropdown position-relative d-lg-none d-flex align-items-center gap-2 ps-2 ps-sm-3 py-2"
      >
        <DropdownToggleButton
          :open="nav.open.value"
          :onClick="nav.toggle"
          icon="bi-book"
          ariaLabel="Library menu"
          className="d-flex align-items-center justify-content-center"
        />
        <span class="fw-semibold d-none d-sm-inline">Skypiea</span>
        <div
          v-if="nav.open.value"
          class="dropdown-menu app-dropdown-menu app-dropdown-menu-start show p-2 d-flex flex-column"
          style="width: 16rem; max-width: 90vw; max-height: 70vh"
        >
          <LibraryNavContent
            :view="view"
            :selectView="selectView"
            :recentCount="recent.length"
            :allCount="(books ?? []).length"
            :authorEntries="authorEntries"
            :subjectEntries="subjectEntries"
            :publisherEntries="publisherEntries"
            :displayName="session?.creds.displayName"
            :onLock="lock"
          />
        </div>
      </div>

      <!-- Content cell: same horizontal padding (px-3) as the right pane's
           own header row below, so the search bar's left edge lines up
           with the book list's heading/rows. -->
      <div class="flex-grow-1 d-flex align-items-center px-3 py-2" style="min-width: 0">
        <div class="position-relative search-bar-width">
          <i
            class="bi bi-search position-absolute top-50 start-0 translate-middle-y ms-3 text-body-secondary pe-none"
            aria-hidden="true"
          />
          <input
            type="search"
            class="form-control themed-control ps-5"
            placeholder="Search library"
            v-model="search"
            aria-label="Search library"
          />
        </div>
      </div>
    </div>

    <div class="flex-grow-1 d-flex flex-column flex-lg-row overflow-hidden">
      <div class="library-nav border-end p-2 d-none d-lg-flex">
        <LibraryNavContent
          :view="view"
          :selectView="selectView"
          :recentCount="recent.length"
          :allCount="(books ?? []).length"
          :authorEntries="authorEntries"
          :subjectEntries="subjectEntries"
          :publisherEntries="publisherEntries"
          :displayName="session?.creds.displayName"
          :onLock="lock"
        />
      </div>

      <div class="flex-grow-1 d-flex flex-column overflow-hidden" style="min-width: 0">
        <div class="d-flex justify-content-between align-items-baseline px-3 py-2 border-bottom">
          <h2 class="h6 mb-0">{{ viewData.heading }}</h2>
          <span class="small text-body-secondary">{{ viewData.headingDetail }}</span>
        </div>

        <div class="flex-grow-1 overflow-auto">
          <p v-if="loading" class="text-body-secondary p-3">Loading your library…</p>

          <template v-if="!loading && view.kind === 'recent'">
            <div class="small text-body-secondary text-uppercase fw-semibold px-3 pt-3 pb-1">Continue Reading</div>
            <div class="list-group list-group-flush">
              <BookRow
                v-for="book in continueReading"
                :key="book.txtId"
                :book="book"
                :onClick="() => openBook(book)"
                :onDelete="() => void removeAccessEntry(book.txtId)"
                hidePartNum
              />
              <p v-if="continueReading.length === 0" class="text-body-secondary px-3 pb-3">No books in progress yet.</p>
            </div>

            <div class="small text-body-secondary text-uppercase fw-semibold px-3 pt-4 pb-1">Recent Bookmarks</div>
            <div class="list-group list-group-flush">
              <BookmarkRow
                v-for="item in recentBookmarkItems"
                :key="`${item.txtId}-${item.createdAt}`"
                :title="item.info.title"
                :partNum="item.partNum"
                :line="item.line"
                :txtPreview="item.txtPreview"
                :onClick="() => openBookmark(item)"
                :onDelete="() => void removeBookmarkEntry(item.txtId, item.createdAt)"
                :deleteAriaLabel="`Remove this bookmark in ${item.info.title}`"
              />
              <p v-if="recentBookmarkItems.length === 0" class="text-body-secondary px-3 pb-3">No bookmarks yet.</p>
            </div>
          </template>

          <div v-if="!loading && view.kind !== 'recent' && viewData.browseList" class="list-group list-group-flush">
            <button
              v-for="entry in viewData.browseList"
              :key="entry.value"
              type="button"
              class="list-group-item list-group-item-action d-flex justify-content-between align-items-center"
              @click="
                selectView({
                  kind: 'browseValue',
                  dimension: (view as { dimension: BrowseDimension }).dimension,
                  value: entry.value,
                })
              "
            >
              <span class="text-truncate" style="min-width: 0">{{ entry.value }}</span>
              <span class="text-body-secondary flex-shrink-0 ms-2">{{ entry.count }}</span>
            </button>
            <p v-if="viewData.browseList.length === 0" class="text-body-secondary p-3">Nothing here yet.</p>
          </div>

          <div v-if="!loading && view.kind !== 'recent' && viewData.bookList" class="list-group list-group-flush">
            <BookRow v-for="book in viewData.bookList" :key="book.txtId" :book="book" :onClick="() => openBook(book)" />
            <p v-if="viewData.bookList.length === 0" class="text-body-secondary p-3">No books match here yet.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
