<script setup lang="ts">
// Screen 3 -- Reader (docs/ui.md): a reading pane with a part-navigation bar
// along the bottom. "About this book" is a dropdown off the top bar;
// "Bookmarks" is a dropdown off the bottom bar (opening upward, since it's
// anchored near the bottom of the screen) -- both closed by default, no
// persistent side panel, the reading pane is always full width.
//
// Bookmarking is per-line (docs/data_model.md's bookmarks: {part_num, line,
// txt_preview}), not per-part: each line in the reading pane has its own
// gutter bookmark button, so "bookmark by line number" is just "click the
// line's own icon" -- no separate number-entry control needed.

import { computed, ref, watch, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";

// Literata: a serif typeface designed for long-form reading (Google Fonts'
// dedicated ebook font), self-hosted via @fontsource rather than fetched
// from a remote origin -- consistent with this app's other assets
// (leancrypto/brotli wasm, bootstrap-icons' font) and required by index.html's
// CSP, which only allows font-src 'self'. Only the two weights the reading
// pane actually renders (400 for line text, 500 for the title heading, which
// inherits Bootstrap's default heading weight) are imported.
import "@fontsource/literata/400.css";
import "@fontsource/literata/500.css";

import BookmarkRow from "../../components/BookmarkRow.vue";
import DropdownToggleButton from "../../components/DropdownToggleButton.vue";
import { useDropdown } from "../../composables/useDropdown";
import { splitLines, truncatePreview } from "./readerModel";
import { descriptionPlainText, sanitizeDescriptionHtml } from "./sanitizeHtml";
import { useReaderBook } from "./composables/useReaderBook";

function lineElementId(lineNum: number): string {
  return `reader-line-${lineNum}`;
}

const DESCRIPTION_PREVIEW_LEN = 200;

// The reading pane's body-text size -- a plain per-session preference (not
// persisted, not part of the vault), so a fresh visit always starts at the
// default rather than carrying over a size chosen for a different book.
const FONT_SIZES_PX = [14, 16, 18, 20, 22, 24];
const DEFAULT_FONT_SIZE_PX = 16;

const route = useRoute();
const router = useRouter();
const numericTxtId = computed(() => Number(route.params.txtId));
const infoMenu = useDropdown();
const bookmarksMenu = useDropdown();
const descriptionExpanded = ref(false);
const fontSizePx = ref(DEFAULT_FONT_SIZE_PX);

const {
  loading,
  error,
  info,
  partCount,
  currentPartNum,
  partText,
  partTextLoading,
  bookmarks,
  targetLine,
  clearTargetLine,
  goToPart,
  goToBookmark,
  next,
  previous,
  bookmarkLine,
  removeBookmark,
} = useReaderBook(numericTxtId);

// The bottom bar's editable part-number box: a local, freely-typeable string
// kept in sync with currentPartNum whenever *that* changes (paging, a
// bookmark jump, ...), but not on every keystroke -- otherwise typing would
// be overwritten mid-edit.
const partInput = ref(String(currentPartNum.value));
watch(currentPartNum, (value) => {
  partInput.value = String(value);
});

function commitPartInput(): void {
  const parsed = Number(partInput.value);
  if (Number.isInteger(parsed) && parsed > 0) {
    goToPart(parsed); // clamps to [1, partCount] itself
  } else {
    partInput.value = String(currentPartNum.value);
  }
}

// Filters non-digits and caps the length as the user types. Also writes the
// filtered value straight back onto the DOM node, not just the ref: Vue's own
// patch of a controlled :value binding lands on the next tick (a microtask),
// unlike React, which resets a controlled input's DOM value synchronously
// within the same input event -- without this, fast/simulated keystrokes can
// land against a stale (unfiltered) native value before Vue's own patch ever
// catches up.
function handlePartInput(event: Event): void {
  const target = event.target as HTMLInputElement;
  const filtered = target.value.replace(/\D/g, "").slice(0, partCountDigits.value);
  partInput.value = filtered;
  target.value = filtered;
}

// A fresh book starts with its description collapsed again.
watch(numericTxtId, () => {
  descriptionExpanded.value = false;
});

const lines = computed(() => (partText.value ? splitLines(partText.value) : []));

// Once a targeted line's text is actually on screen, scroll to it -- set by
// clicking a bookmark (here or in Library's Recent Bookmarks) rather than
// just landing on its part. partText === null (not just !loading/
// !partTextLoading) matters here: right after switching books/parts there's
// a moment where loading and partTextLoading are both momentarily false
// again but partText is still the *previous* part's (useReaderBook clears it
// to null up front, before fetching the new one) -- without this check this
// watcher would fire against that stale content and clear targetLine before
// the real text (and its line elements) ever appears.
// watchEffect, not watch([...], ..., {immediate: true}): a watch()'s
// immediate call runs synchronously at setup() time (before this
// component's own first render), regardless of flush timing -- flush:
// "post" only applies once there's a *previous* value to diff against, so
// document.getElementById(...) below would find nothing on that first call.
// watchEffect has no separate "immediate" case -- flush: "post" governs its
// very first run too, so it correctly waits until after the reading pane's
// DOM (including this target line's element) actually exists.
watchEffect(
  () => {
    if (loading.value || partTextLoading.value || partText.value === null || targetLine.value === null) return;
    document.getElementById(lineElementId(targetLine.value))?.scrollIntoView({ behavior: "smooth", block: "center" });
    clearTargetLine();
  },
  { flush: "post" },
);

const bookmarkedLines = computed(
  () => new Set(bookmarks.value.filter((b) => b.partNum === currentPartNum.value).map((b) => b.line)),
);
// The part-number box's width scales with partCount's own digit count (1
// part vs. 999 parts shouldn't share a box sized for the wider of the two)
// rather than a fixed guess -- and maxlength tracks it so the box never
// invites typing more digits than it can display.
const partCountDigits = computed(() => String(partCount.value || 1).length);
// partCount starts at 0 until the first load resolves (see useReaderBook) --
// "1 / 0" would misleadingly claim there's a known current part out of a
// book with no parts, so show "-" for both instead of a real-looking but
// meaningless number.
const partCountKnown = computed(() => partCount.value > 0);
const seriesLabel = computed(() =>
  info.value?.series ? `${info.value.series}${info.value.seriesIndex ? `, #${info.value.seriesIndex}` : ""}` : null,
);
// Calibre/OPF descriptions commonly carry HTML (see sanitizeHtml.ts) -- and
// this book's metadata may come from a document someone else shared with
// this account, so it must be sanitized before rendering. The collapsed
// preview uses the plain-text version so truncating at a character count
// can't cut a tag in half; the expanded view uses the full sanitized HTML so
// real formatting (bold/italic/lists/...) shows.
const descriptionHtml = computed(() =>
  info.value?.description ? sanitizeDescriptionHtml(info.value.description) : null,
);
const descriptionPlain = computed(() =>
  info.value?.description ? descriptionPlainText(info.value.description) : null,
);
const descriptionIsLong = computed(() => (descriptionPlain.value?.length ?? 0) > DESCRIPTION_PREVIEW_LEN);

// Two independent dropdowns (Info and Bookmarks), but opening one should
// still close the other -- useDropdown() itself has no notion of sibling
// menus, so that coordination happens here.
function toggleInfo(): void {
  infoMenu.toggle();
  bookmarksMenu.close();
}

function toggleBookmarks(): void {
  bookmarksMenu.toggle();
  infoMenu.close();
}
</script>

<template>
  <div v-if="error" class="shell-60 d-flex flex-column vh-100">
    <div class="border-bottom d-flex align-items-center gap-3 ps-2 ps-sm-3 pe-3 py-2">
      <button
        type="button"
        class="btn btn-link text-decoration-none px-0"
        @click="router.push('/library')"
        aria-label="Back to library"
        title="Back to library"
      >
        <i class="bi bi-arrow-left" aria-hidden="true" />
      </button>
    </div>
    <div class="alert alert-danger m-4" role="alert">
      {{ error }}
    </div>
  </div>

  <div v-else class="shell-60 d-flex flex-column vh-100">
    <div class="border-bottom d-flex align-items-center gap-3 ps-2 ps-sm-3 pe-3 py-2">
      <button
        type="button"
        class="btn btn-link text-decoration-none px-0"
        @click="router.push('/library')"
        aria-label="Back to library"
        title="Back to library"
      >
        <i class="bi bi-arrow-left" aria-hidden="true" />
      </button>
      <div class="flex-grow-1 text-truncate">
        <div class="text-truncate">
          <span class="fw-semibold">{{ info?.title ?? `txt_${numericTxtId}` }}</span>
          <span v-if="info?.author" class="text-body-secondary d-none d-sm-inline"> / {{ info.author }}</span>
        </div>
        <!-- Below sm there's no room to share a line with the title -- the
             author gets its own second line instead of being squeezed in. -->
        <div v-if="info?.author" class="text-body-secondary small text-truncate d-sm-none">{{ info.author }}</div>
      </div>

      <div :ref="(el) => (infoMenu.ref.value = el as HTMLElement | null)" class="dropdown position-relative">
        <DropdownToggleButton
          :open="infoMenu.open.value"
          :onClick="toggleInfo"
          icon="bi-info-lg"
          ariaLabel="About this book"
          title="About this book"
        />
        <div
          v-if="infoMenu.open.value"
          class="dropdown-menu app-dropdown-menu show p-3"
          style="width: 20rem; max-width: 90vw; max-height: 70vh; overflow-y: auto"
        >
          <div class="fw-semibold">{{ info?.title ?? `txt_${numericTxtId}` }}</div>
          <div v-if="info?.author">{{ info.author }}</div>
          <div v-if="seriesLabel" class="text-body-secondary small">{{ seriesLabel }}</div>
          <div v-if="info && info.subjects.length > 0" class="mt-2">
            <span v-for="subject in info.subjects" :key="subject" class="badge text-bg-secondary me-1 mb-1">{{
              subject
            }}</span>
          </div>
          <div v-if="descriptionHtml" class="fst-italic small mt-2">
            <span v-if="descriptionExpanded || !descriptionIsLong" v-html="descriptionHtml"></span>
            <span v-else>{{ truncatePreview(descriptionPlain ?? "", DESCRIPTION_PREVIEW_LEN) }}</span>
            <button
              v-if="descriptionIsLong"
              type="button"
              class="btn btn-link btn-sm p-0 ms-1 align-baseline"
              @click="descriptionExpanded = !descriptionExpanded"
            >
              {{ descriptionExpanded ? "Show less" : "Show more" }}
            </button>
          </div>
          <!-- The curated fields above (title/author/series/subjects/
               description) exist for their own special-purpose rendering;
               this is the complete record underneath -- every OPF/Calibre
               field this book's metadata carries, verbatim key and values,
               so nothing from the catalog entry is hidden. -->
          <div v-if="info && info.rawMetadata.length > 0" class="mt-3 pt-2 border-top">
            <div class="text-body-secondary text-uppercase small fw-semibold mb-1">All metadata</div>
            <div class="small">
              <div v-for="field in info.rawMetadata" :key="field.key" class="d-flex gap-2">
                <span class="text-body-secondary text-nowrap">{{ field.key }}</span>
                <span class="text-truncate">{{ field.values.join(", ") }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex-grow-1 overflow-auto ps-2 ps-sm-4 pe-4 py-4">
      <!-- max-width in `ch` (the width of "0" in this element's own font) --
           not a fixed rem value -- so the reading column's line length stays
           around 70 characters regardless of which font size is picked
           below, rather than cramming more characters per line into the
           same fixed pixel width at a smaller size (or fewer at a larger
           one). It's still a *max*-width: on a narrow viewport the column is
           capped by the available width same as before, just with fewer
           than 70 characters per line rather than overflowing. -->
      <div class="mx-auto reader-font" :style="{ maxWidth: '70ch', fontSize: `${fontSizePx}px` }">
        <div v-if="!loading" class="small text-body-secondary text-uppercase mb-3">
          Part {{ currentPartNum }} of {{ partCount }}
        </div>
        <h2 v-if="!loading && info?.title" class="h4 mb-3">{{ info.title }}</h2>
        <div v-if="loading || partTextLoading" class="d-flex justify-content-center py-5">
          <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading…</span>
          </div>
        </div>
        <template v-if="!loading && !partTextLoading">
          <div
            v-for="(line, i) in lines"
            :key="i + 1"
            :id="lineElementId(i + 1)"
            class="reader-line d-flex align-items-start gap-2"
          >
            <button
              type="button"
              :class="`bookmark-toggle btn btn-sm p-0 border-0 bg-transparent lh-1 mt-1 ${
                bookmarkedLines.has(i + 1) ? 'is-bookmarked text-primary' : 'text-body-tertiary'
              }`"
              @click="bookmarkLine(i + 1, truncatePreview(line))"
              :aria-pressed="bookmarkedLines.has(i + 1)"
              :aria-label="`Bookmark line ${i + 1}`"
              :title="`Bookmark line ${i + 1}`"
            >
              <i :class="`bi ${bookmarkedLines.has(i + 1) ? 'bi-bookmark-fill' : 'bi-bookmark'}`" aria-hidden="true" />
            </button>
            <p class="flex-grow-1">{{ line }}</p>
          </div>
        </template>
      </div>
    </div>

    <div class="border-top d-flex align-items-center gap-2 gap-sm-3 ps-2 ps-sm-3 pe-3 py-2">
      <select
        class="form-select form-select-sm themed-control font-size-select"
        style="width: 4.25rem"
        :value="fontSizePx"
        @change="fontSizePx = Number(($event.target as HTMLSelectElement).value)"
        aria-label="Font size"
      >
        <option v-for="size in FONT_SIZES_PX" :key="size" :value="size">{{ size }}px</option>
      </select>

      <div class="vr bottom-bar-vr" />

      <!-- Previous/part-box/Next stay tightly grouped (gap-1) -- they're one
           control, unlike the looser gap-2/gap-sm-3 spacing the outer bar
           uses around the font-size dropdown, this group, and the vr
           dividers on either side of it. -->
      <div class="d-flex align-items-center gap-1">
        <button
          type="button"
          class="btn btn-sm btn-link p-0 text-decoration-none"
          @click="previous"
          :disabled="loading || currentPartNum <= 1"
          aria-label="Previous part"
        >
          <i class="bi bi-chevron-left text-primary" aria-hidden="true" />
        </button>

        <div class="d-flex align-items-center gap-1 text-body-secondary small text-nowrap">
          <!-- No native maxlength here (unlike the React version): a native
               maxlength enforces itself on the raw keystroke before
               handlePartInput ever runs, and would just as easily lock out
               further digits mid-keystroke as help -- handlePartInput's own
               filter + slice(0, partCountDigits) (synced straight back onto
               the DOM node, see its comment) is the real source of truth for
               the cap. -->
          <input
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            class="form-control form-control-sm themed-control text-center"
            :style="{ width: `calc(${partCountDigits}ch + 2rem)` }"
            :value="partCountKnown ? partInput : '-'"
            :disabled="loading || !partCountKnown"
            @input="handlePartInput"
            @blur="commitPartInput"
            @keydown="
              (event: KeyboardEvent) => {
                if (event.key === 'Enter') {
                  commitPartInput();
                  (event.currentTarget as HTMLInputElement).blur();
                }
              }
            "
            aria-label="Go to part"
          />
          <span>/ {{ partCountKnown ? partCount : "-" }}</span>
        </div>

        <button
          type="button"
          class="btn btn-sm btn-link p-0 text-decoration-none"
          @click="next"
          :disabled="loading || currentPartNum >= partCount"
          aria-label="Next part"
        >
          <i class="bi bi-chevron-right text-primary" aria-hidden="true" />
        </button>
      </div>

      <div class="vr bottom-bar-vr" />

      <div
        :ref="(el) => (bookmarksMenu.ref.value = el as HTMLElement | null)"
        class="dropdown position-relative ms-auto"
      >
        <DropdownToggleButton
          :open="bookmarksMenu.open.value"
          :onClick="toggleBookmarks"
          :icon="bookmarks.length > 0 ? 'bi-bookmark-fill' : 'bi-bookmark'"
          ariaLabel="Bookmarks"
          title="Bookmarks"
        />
        <div
          v-if="bookmarksMenu.open.value"
          class="dropdown-menu app-dropdown-menu app-dropdown-menu-up show p-3"
          style="width: 20rem; max-width: 90vw; max-height: 70vh; overflow-y: auto"
        >
          <p v-if="bookmarks.length === 0" class="small text-body-secondary mb-0">No bookmarks yet.</p>
          <BookmarkRow
            v-for="bookmark in bookmarks"
            :key="bookmark.createdAt"
            :partNum="bookmark.partNum"
            :line="bookmark.line"
            :txtPreview="bookmark.txtPreview"
            :onClick="() => goToBookmark(bookmark.partNum, bookmark.line)"
            :onDelete="() => removeBookmark(bookmark.createdAt)"
            :deleteAriaLabel="`Remove this bookmark (part ${bookmark.partNum}, line ${bookmark.line})`"
            className="d-flex align-items-start gap-2 mb-2 w-100"
          />
        </div>
      </div>
    </div>
  </div>
</template>
