import { create } from "zustand";
import { uid } from "@/lib/utils";

export type ToastType = "success" | "error" | "info";

export interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = uid("toast");
    set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helper usable from anywhere (stores, event handlers). */
export function showToast(type: ToastType, title: string, description?: string): string {
  return useToastStore.getState().push({ type, title, description });
}
