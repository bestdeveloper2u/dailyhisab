import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { useAuthStore } from "./store/auth";
import "./index.css";

// PWA (T9.1): autoUpdate — the SW activates as soon as a new version is
// precached; no user-facing update prompt this cycle. No-op in dev and in
// browsers without service-worker support.
registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});

// Restore the session before first paint matters: while bootstrap() runs the
// store stays in `loading` and RequireAuth shows the themed spinner.
void useAuthStore.getState().bootstrap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
