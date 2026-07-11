import { create } from "zustand";

export const useUiStore = create((set) => ({
  theme: "dark",
  sidebarOpen: false,
  toggleSidebar: () =>
    set((s: { sidebarOpen: boolean }) => ({ sidebarOpen: !s.sidebarOpen })),
}));
