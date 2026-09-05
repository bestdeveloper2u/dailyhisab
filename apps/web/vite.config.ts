/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

/*
 * No react/react-dom resolve aliases and no vitest `server.deps.inline` list.
 *
 * The workspace is pinned to a single React: apps/mobile (Expo/RN 0.81.6)
 * requires react 19.1.0, apps/web now declares exactly 19.1.0, and the root
 * package.json pnpm.overrides force every transitive consumer onto it. With
 * one physical react copy in node_modules, plain Node resolution is shared by
 * vite-transformed imports and CJS require("react") alike — no split runtime,
 * no hook-dispatcher mismatch.
 */

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    /*
     * PWA offline support (ticket T9.1).
     *
     * Precache: the built app-shell only (hashed JS/CSS, index.html, icons,
     * fonts) so the UI boots with zero network. Navigation requests fall back
     * to the precached index.html (SPA deep links work offline), except for
     * /api/** which must ALWAYS hit the network — financial data is never
     * served stale from a cache.
     *
     * Runtime caching: deliberately NONE. Unmatched requests (every /api/v1/*
     * call) bypass the workbox router entirely and go straight to the network,
     * so balances, expenses and debts can never be answered from cache.
     */
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      manifest: {
        name: "দৈনিক হিসাব",
        short_name: "Daily Hisab",
        description:
          "দৈনিক খরচের হিসাব রাখার সহজ অ্যাপ — অফলাইনেও কাজ করে।",
        lang: "bn",
        dir: "ltr",
        display: "standalone",
        start_url: "/",
        // Colors from the frozen prototype palette (www/index.html :root).
        theme_color: "#0E6B50",
        background_color: "#F6F5F1",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "pwa-maskable-192x192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "pwa-maskable-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico,woff,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // API base URL is '' in dev — same-origin /api/v1/* calls land here.
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: "./tests/setup.ts",
  },
});
