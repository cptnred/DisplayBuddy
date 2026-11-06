/**
 * Build of the installable web app (PLAN_V3_SYNC §9.1) → dist-web/.
 *
 * vite-plugin-pwa 2.0.0 (peer vite ^8) with `strategies: 'injectManifest'` and an own
 * service worker (src/web/sw.ts), `registerType: 'prompt'`, `injectRegister: null`
 * (registration through `virtual:pwa-register/react`; the server CSP forbids inline
 * scripts). Sources: vite-pwa/docs guide/inject-manifest.md, guide/register-service-worker.md,
 * frameworks/react.md, guide/pwa-minimal-requirements.md.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "node:path";

const r = (p: string) => resolve(import.meta.dirname, p);

export const THEME_COLOR = "#1F6F78";

/** The web entry is web.html in the repo (index.html is not ours); serve it as /index.html. */
function webHtmlAsIndex(): Plugin {
  return {
    name: "buddy-web-html-as-index",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      // Rolldown forbids assigning into `bundle`: delete + emitFile instead.
      const html = bundle["web.html"];
      if (html && html.type === "asset") {
        delete bundle["web.html"];
        this.emitFile({ type: "asset", fileName: "index.html", source: html.source });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    webHtmlAsIndex(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/web",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: null,
      manifest: {
        id: "/",
        name: "Display Buddy",
        short_name: "Buddy",
        description: "Notizen und Erinnerungen von Display Buddy – auch offline, mit Benachrichtigungen.",
        lang: "de",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#FFFDF5",
        theme_color: THEME_COLOR,
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // public-web icons are already matched by globPatterns (avoid duplicate precache entries)
      includeManifestIcons: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
      },
      devOptions: { enabled: false },
    }),
  ],
  publicDir: r("public-web"),
  build: {
    outDir: r("dist-web"),
    emptyOutDir: true,
    // TipTap + React in one chunk (~200 kB gzip), precached once
    chunkSizeWarningLimit: 800,
    target: ["chrome111", "safari16.4", "firefox115"],
    rollupOptions: {
      input: { index: r("web.html") },
    },
  },
});
