<script setup lang="ts">
// Catches render/lifecycle errors anywhere below it so one screen crashing
// doesn't blank the whole app -- onErrorCaptured() is Vue's equivalent of
// React's componentDidCatch/getDerivedStateFromError (which needed a class
// component; Vue's composition API hook works from a plain <script setup>).
// Dismissing the message resets the boundary and re-renders children fresh
// (Vue mounts the slot content anew once the v-if below flips back), rather
// than leaving the user stuck until a full reload.
//
// The fallback is a full-viewport, opaque overlay rather than a small inline
// banner: this sits above the vault state (see App.vue), so dismissing
// always lands back on Unlock regardless of what was caught -- consistent
// with state/vault.ts's own no-persistence design, not a new downside. The
// original reason for this (a React 19 reconciler edge case that could leave
// the previous screen's real DOM behind, still visible and clickable, even
// once React's own tree had moved on -- see the CLAUDE.md history around
// the React->Vue migration) doesn't apply to Vue's patching model, but the
// overlay is still worth keeping as generally good crash UX regardless.

import { onErrorCaptured, ref } from "vue";

import { verbose } from "../log";

const error = ref<Error | null>(null);

onErrorCaptured((err) => {
  const asError = err instanceof Error ? err : new Error(String(err));
  verbose("ErrorBoundary caught", asError);
  error.value = asError;
  return false;
});

function handleClose(): void {
  error.value = null;
}
</script>

<template>
  <slot v-if="!error" />
  <div
    v-else
    class="position-fixed top-0 start-0 w-100 h-100 bg-body d-flex align-items-center justify-content-center p-4"
    style="z-index: 2000"
  >
    <div class="alert alert-danger d-flex flex-column gap-2 w-100" role="alert" style="max-width: 28rem">
      <div class="d-flex align-items-start justify-content-between gap-3">
        <div>{{ error.message || "Something went wrong." }}</div>
        <button
          type="button"
          class="btn btn-xs btn-outline-secondary border-0 flex-shrink-0"
          aria-label="Close"
          @click="handleClose"
        >
          <i class="bi bi-x-lg" aria-hidden="true" />
        </button>
      </div>
      <div class="small text-body-secondary">You'll need to unlock your library again to continue.</div>
    </div>
  </div>
</template>
