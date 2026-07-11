<template>
  <span class="badge">{{ store.items.length }}</span>
</template>

<script setup lang="ts">
import { useCartStore } from "./stores/cart";
const store = useCartStore();
</script>
