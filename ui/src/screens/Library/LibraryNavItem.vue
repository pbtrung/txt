<script setup lang="ts">
defineProps<{
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}>();
</script>

<template>
  <button
    type="button"
    :class="`list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-2 ${active ? 'active' : ''}`"
    @click="onClick"
  >
    <span class="text-truncate">{{ label }}</span>
    <span :class="`flex-shrink-0 ${active ? '' : 'text-body-secondary'}`">{{ count }}</span>
  </button>
</template>
