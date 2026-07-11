<template>
  <button @click="submit">Pay ({{ store.items.length }})</button>
</template>

<script setup lang="ts">
import { useCartStore } from "./stores/cart";
const store = useCartStore();
const submit = () => {
  store.$patch({ items: [] });
};
</script>
