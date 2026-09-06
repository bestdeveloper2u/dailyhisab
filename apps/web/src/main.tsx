import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { UpdateToastHost } from "./components/UpdateToast";
import { notifyAppUpdate } from "./components/UpdateToastStore";
import { useAuthStore } from "./store/auth";
import "./index.css";

// PWA update flow (T16.2): registration stays immediate (and still a no-op in
// dev and in browsers without service-worker support), but a new version is
// no longer swallowed silently — the branded refresh toast is shown instead.
// Two plugin paths feed the same panel:
//   - onNeedRefresh: prompt-type SWs — a new worker is installed and waiting;
//     updateSW() sends SKIP_WAITING and the plugin runtime reloads once the
//     new worker takes control.
//   - onNeedReload: autoUpdate-type SWs (the current vite.config registerType)
//     — the new worker activates itself and the plugin would hard-reload the
//     tab mid-session; we intercept and let the user pick the moment instead.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => notifyAppUpdate(() => void updateSW()),
  onNeedReload: () => notifyAppUpdate(() => window.location.reload()),
});

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
    {/* Needs no router/query/auth context: reads the lang store and the
        update-prompt slot directly (T16.2). Sits above the message toast. */}
    <UpdateToastHost />
  </StrictMode>,
);
