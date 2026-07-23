<script setup lang="ts">
// Shared wordmark used on the Unlock screen and the Library top bar
// (docs/ui.md's "[library] Skypiea").
withDefaults(defineProps<{ size?: "md" | "lg" }>(), { size: "md" });
</script>

<template>
  <span :class="['d-inline-flex align-items-center gap-2', size === 'lg' ? 'fs-2' : '']">
    <i class="bi bi-book text-primary" aria-hidden="true" />
    <span class="fw-semibold">Skypiea</span>
  </span>
</template>
