/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;
const r = (p: string) => resolve(import.meta.dirname, p);

export default defineConfig(() => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // One HTML entry per window so the buddy window never loads TipTap.
  build: {
    target: "chrome120",
    rollupOptions: {
      input: {
        buddy: r("buddy.html"),
        notes: r("notes.html"),
        settings: r("settings.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: { modules: { classNameStrategy: "non-scoped" } },
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
