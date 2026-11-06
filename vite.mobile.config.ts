/**
 * Build of the UI for the native shell (PLAN_V3_SYNC §10.1) → mobile/dist/
 * (frontendDist of mobile/src-tauri/tauri.conf.json).
 *
 * Same React UI as the PWA, but entry mobile/index.html → mobile/src/main.tsx and
 * deliberately WITHOUT vite-plugin-pwa / service worker / manifest: the app is served
 * by Tauri from the bundle, local notifications come from the OS.
 *
 * Dev: `cd mobile && npx tauri android dev` starts this on port 1422 (TAURI_DEV_HOST
 * for a device on the LAN, Tauri docs „Develop → Mobile“).
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import process from "node:process";

const r = (p: string) => resolve(import.meta.dirname, p);
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: r("mobile"),
  plugins: [react()],
  // the shell needs no manifest/icons from public-web (Tauri bundles its own icons)
  publicDir: false,
  clearScreen: false,
  server: {
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1423 } : undefined,
    fs: { allow: [r(".")] },
    watch: { ignored: ["**/src-tauri/**", "**/mobile/src-tauri/**"] },
  },
  build: {
    outDir: r("mobile/dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    // Android System WebView follows Chrome; WKWebView = Safari of the iOS version (min. 16)
    target: ["chrome111", "safari16"],
    rollupOptions: {
      input: { index: r("mobile/index.html") },
    },
  },
});
