<script setup lang="ts">
// A single bookmark row: part/line, a preview of that line's text, and a
// delete button. Shared by Library's "Recent Bookmarks" (Recent view, which
// spans every book so it shows the title too, styled as a list-group row)
// and Reader's Bookmarks dropdown (already scoped to one book, so title is
// omitted, and it isn't inside a .list-group -- className lets it supply its
// own plain row styling instead).

import ClickableRow from "./ClickableRow.vue";
import DeleteButton from "./DeleteButton.vue";

withDefaults(
  defineProps<{
    title?: string;
    partNum: number;
    line: number;
    txtPreview: string;
    onClick: () => void;
    onDelete: () => void;
    deleteAriaLabel: string;
    className?: string;
  }>(),
  { className: "list-group-item list-group-item-action d-flex align-items-start gap-3 py-3" },
);
</script>

<template>
  <ClickableRow :onClick="onClick" :className="className">
    <i class="bi bi-bookmark-fill text-primary mt-1 flex-shrink-0" aria-hidden="true" />
    <span class="overflow-hidden flex-grow-1" style="min-width: 0">
      <span v-if="title" class="d-block fw-semibold text-truncate">{{ title }}</span>
      <span class="d-block small text-body-secondary">Part {{ partNum }} · Line {{ line }}</span>
      <span class="d-block text-body-secondary fst-italic small text-truncate">&ldquo;{{ txtPreview }}&rdquo;</span>
    </span>
    <DeleteButton :onClick="onDelete" :ariaLabel="deleteAriaLabel" />
  </ClickableRow>
</template>
