/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
  plugins: [react(), tailwindcss()],
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
