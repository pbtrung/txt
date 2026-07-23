<script setup lang="ts">
// The toggle button for a useDropdown()-backed menu (Library's nav drawer,
// Reader's Info/Bookmarks) -- same open/closed styling and aria wiring in
// all three; only the icon, label, and (for Library's nav button) an extra
// centering class differ.

defineProps<{
  open: boolean;
  onClick: () => void;
  icon: string;
  ariaLabel: string;
  title?: string;
  className?: string;
}>();
</script>

<template>
  <button
    type="button"
    :class="`btn btn-sm ${open ? 'btn-primary' : 'btn-outline-secondary border-primary'}${className ? ` ${className}` : ''}`"
    @click="onClick"
    :aria-expanded="open"
    aria-haspopup="true"
    :aria-label="ariaLabel"
    :title="title"
  >
    <i :class="`bi ${icon} ${open ? '' : 'text-primary'}`" aria-hidden="true" />
  </button>
</template>
