import { defineStore } from "pinia";

export const useCartStore = defineStore("cart", {
  state: () => ({ items: [] as string[] }),
});
