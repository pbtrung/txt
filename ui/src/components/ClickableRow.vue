<script setup lang="ts">
// A list row that's clickable as a whole (Library's book/bookmark rows,
// Reader's bookmark list) but also nests its own delete button -- a real
// <button> can't contain another button, so this plays the button role on a
// div instead, wiring up Enter/Space the same way a real button would.

const props = defineProps<{
  onClick: () => void;
  className: string;
}>();

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    props.onClick();
  }
}
</script>

<template>
  <div role="button" tabindex="0" :class="className" @click="onClick" @keydown="handleKeyDown">
    <slot />
  </div>
</template>
