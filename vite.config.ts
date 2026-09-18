import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * GitHub Pages base path resolution (browser-only static hosting).
 *
 * 1. `VITE_BASE_PATH` — explicit override, e.g. "/" for a user/org page.
 * 2. `GITHUB_REPOSITORY` — injected by GitHub Actions, e.g. "owner/TalkQ-web"
 *    becomes "/TalkQ-web/", while "owner/owner.github.io" becomes "/".
 * 3. Local default — "/TalkQ-web/", the repository this client is published under.
 *
 * The base is never hardcoded to "/", so a project page such as
 * https://<user>.github.io/TalkQ-web/ resolves every asset correctly.
 */
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const derivedBase = repoName
  ? repoName.toLowerCase().endsWith(".github.io")
    ? "/"
    : `/${repoName}/`
  : "/TalkQ-web/";
const base = process.env.VITE_BASE_PATH ?? derivedBase;

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: false,
    // `npm run dev` opens the browser for you — the app is NOT meant to be
    // opened by double-clicking index.html (file:// blocks ES modules).
    open: true,
  },
  preview: {
    port: 4173,
    strictPort: false,
    open: true,
  },
});
