<script setup lang="ts">
// Screen 1 -- Unlock (docs/ui.md): the only job here is loading the
// credential file. No headline, no explanatory copy, no dropzone preview --
// a wordmark and a single button carrying both the action and its effect.

import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import Wordmark from "../../components/Wordmark.vue";
import { useVault } from "../../state/vault";

const { status, error, unlock } = useVault();
const router = useRouter();
const inputRef = ref<HTMLInputElement | null>(null);

// immediate: true -- matches the original useEffect's semantics, which
// always runs once right after mount regardless of dependency changes (e.g.
// if this screen ever mounted with status already "unlocked"), not just on
// a later change.
watch(
  status,
  (current) => {
    if (current === "unlocked") {
      router.replace("/library");
    }
  },
  { immediate: true },
);

async function handleFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = ""; // allow re-selecting the same file after an error
  if (file) {
    await unlock(file);
  }
}

const unlocking = computed(() => status.value === "unlocking");
</script>

<template>
  <div class="d-flex align-items-center justify-content-center vh-100">
    <div class="text-center" style="max-width: 24rem">
      <div class="mb-4">
        <Wordmark size="lg" />
      </div>

      <button
        type="button"
        class="btn btn-primary btn-lg d-flex align-items-center gap-3 px-4 py-3 mx-auto"
        @click="inputRef?.click()"
        :disabled="unlocking"
      >
        <i class="bi bi-file-earmark fs-2" aria-hidden="true" />
        <span class="text-start lh-sm">
          <span class="d-block fw-semibold">{{ unlocking ? "Unlocking…" : "Choose File" }}</span>
          <span class="d-block small fw-normal">to unlock your library</span>
        </span>
      </button>

      <!-- role="status" on the wrapper, not the (otherwise unlabeled)
           spinner glyph itself -- the visible text is what actually gets
           announced, so the spinner is just decorative next to it. -->
      <div v-if="unlocking" class="mt-4 d-flex flex-column align-items-center gap-2" role="status">
        <div class="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
        <div class="small text-body-secondary">Setting up your library…</div>
      </div>

      <div v-if="error" class="alert alert-danger mt-4" role="alert">
        {{ error }}
      </div>

      <input
        ref="inputRef"
        type="file"
        accept="application/json,.json"
        class="d-none"
        @change="handleFileChange"
        aria-label="Choose config file"
      />
    </div>
  </div>
</template>
