<script setup lang="ts">
// One row in the Library's book list (docs/ui.md's Screen 2): title on top,
// then `Author · Subject, Subject · Publisher` underneath; "Part N" for an
// in-progress book (no total/progress bar -- Library doesn't fetch
// part_count, see libraryModel.ts), unless hidePartNum is set (the Recent
// view's Continue Reading section doesn't show it). An optional onDelete
// renders a trailing "x" (also just Continue Reading).

import { computed } from "vue";

import { bookStatus, type LibraryBook } from "../screens/Library/libraryModel";
import ClickableRow from "./ClickableRow.vue";
import DeleteButton from "./DeleteButton.vue";

const props = defineProps<{
  book: LibraryBook;
  onClick: () => void;
  onDelete?: () => void;
  hidePartNum?: boolean;
}>();

const status = computed(() => bookStatus(props.book));
const subtitle = computed(() =>
  [props.book.info.author, props.book.info.subjects.join(", "), props.book.info.publisher]
    .filter((part): part is string => Boolean(part))
    .join(" · "),
);
</script>

<template>
  <ClickableRow
    :onClick="onClick"
    className="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3 py-3"
  >
    <!-- minWidth:0 lets a long title/subtitle actually truncate instead of
         forcing this flex item (and its siblings, e.g. the Library's left
         nav) wider than available -- flex items default to min-width:auto,
         which ignores overflow-hidden/text-truncate on a descendant. -->
    <span class="overflow-hidden" style="min-width: 0">
      <span class="d-block fw-semibold text-truncate">{{ book.info.title }}</span>
      <span v-if="subtitle" class="d-block small text-body-secondary text-truncate">{{ subtitle }}</span>
    </span>
    <span class="d-flex align-items-center gap-2 flex-shrink-0">
      <span v-if="status === 'in-progress' && !hidePartNum" class="small text-body-secondary text-nowrap"
        >Part {{ book.lastPartNum }}</span
      >
      <DeleteButton v-if="onDelete" :onClick="onDelete" :ariaLabel="`Remove ${book.info.title} from Recent`" />
    </span>
  </ClickableRow>
</template>
