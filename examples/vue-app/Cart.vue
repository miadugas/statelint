<template>
  <div>{{ items }}</div>
</template>

<script setup lang="ts">
import { useCartStore } from "./stores/cart";
const store = useCartStore();
const items = store.items;
</script>
