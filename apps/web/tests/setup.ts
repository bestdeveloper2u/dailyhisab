import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// The api-client reads VITE_API_URL once at module init. In the jsdom
// environment Node's undici Request cannot be constructed from a relative
// URL, so give tests an absolute base (mirrors the vite dev origin).
vi.stubEnv("VITE_API_URL", "http://127.0.0.1:5173");

// vitest runs with globals:false, so @testing-library/react's automatic
// cleanup does not register itself — do it explicitly.
afterEach(() => {
  cleanup();
});
