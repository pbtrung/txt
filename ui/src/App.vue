<script setup lang="ts">
// The whole app: an ErrorBoundary wrapping whichever screen the router
// (installed in main.ts via createAppRouter(), see router.ts) currently
// matches -- Unlock, Library, or Reader.
import { RouterView } from "vue-router";

import ErrorBoundary from "./components/ErrorBoundary.vue";
</script>

<template>
  <ErrorBoundary>
    <RouterView />
  </ErrorBoundary>
</template>
