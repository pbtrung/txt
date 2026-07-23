<script setup lang="ts">
// The small "x" that removes a single row (Library's Continue Reading/Recent
// Bookmarks, Reader's Bookmarks dropdown) without triggering the row's own
// click (which would otherwise navigate/jump somewhere) -- shared here since
// all three call sites want the exact same button, just with their own
// aria-label and delete callback.

const props = defineProps<{
  onClick: () => void;
  ariaLabel: string;
}>();

function handleClick(event: MouseEvent): void {
  event.stopPropagation();
  props.onClick();
}
</script>

<template>
  <button
    type="button"
    class="btn btn-xs btn-outline-secondary border-0 flex-shrink-0"
    :aria-label="ariaLabel"
    @click="handleClick"
  >
    <i class="bi bi-x-lg" aria-hidden="true" />
  </button>
</template>
