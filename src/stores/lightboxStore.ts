import { create } from "zustand";

interface LightboxState {
  src: string | null;
  caption?: string;
  open: (src: string, caption?: string) => void;
  close: () => void;
}

/** Single shared image viewer, mounted once at the app root. */
export const useLightboxStore = create<LightboxState>((set) => ({
  src: null,
  caption: undefined,
  open: (src, caption) => set({ src, caption }),
  close: () => set({ src: null, caption: undefined }),
}));
