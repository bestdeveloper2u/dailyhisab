import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RecurringAutoRun } from "./lib/recurringRun";
import { useAuthStore } from "./store/auth";

/**
 * Route-level code splitting (T15.1a): every page is a lazy chunk so the
 * initial download is only the shell (router + auth + AppShell). Named
 * exports are re-mapped to React's expected `default`.
 */
const Budget = lazy(() =>
  import("./screens/Budget").then((m) => ({ default: m.Budget })),
);
const Dashboard = lazy(() =>
  import("./screens/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const Debts = lazy(() =>
  import("./screens/Debts").then((m) => ({ default: m.Debts })),
);
const Expenses = lazy(() =>
  import("./screens/Expenses").then((m) => ({ default: m.Expenses })),
);
const Login = lazy(() =>
  import("./screens/Login").then((m) => ({ default: m.Login })),
);
const Month = lazy(() =>
  import("./screens/Month").then((m) => ({ default: m.Month })),
);
const Recurring = lazy(() =>
  import("./screens/Recurring").then((m) => ({ default: m.Recurring })),
);
const Report = lazy(() =>
  import("./screens/Report").then((m) => ({ default: m.Report })),
);
const Settings = lazy(() =>
  import("./screens/Settings").then((m) => ({ default: m.Settings })),
);

/** Themed Suspense fallback shown while a lazy route chunk is downloading. */
function RouteFallback() {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-ivory text-ink"
      role="status"
    >
      <span
        aria-hidden="true"
        className="h-9 w-9 animate-spin rounded-full border-[3px] border-line border-t-emerald"
      />
      <span className="text-sm font-semibold text-muted">লোড হচ্ছে…</span>
    </div>
  );
}

/**
 * Gate for everything under AppShell. While the bootstrap/refresh flow is
 * resolving we show a themed spinner; anonymous visitors are bounced to
 * /login carrying their intended location so Login can send them back.
 */
function RequireAuth() {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ivory text-ink" role="status">
        <span
          aria-hidden="true"
          className="h-9 w-9 animate-spin rounded-full border-[3px] border-line border-t-emerald"
        />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  if (status === "anon") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  // T17.1 (ADR-0014 §3): authed tree host for the once-per-local-day
  // recurring boot run. Renders nothing and never blocks the UI — the
  // POST is fire-and-forget inside the effect below <Outlet/>.
  return (
    <>
      <RecurringAutoRun />
      <Outlet />
    </>
  );
}

/**
 * Route tree. BrowserRouter is provided once in main.tsx so that every
 * component here stays MemoryRouter-compatible for tests.
 */
export default function App() {
  return (
    <ErrorBoundary>
      {/* Suspense sits UNDER the ErrorBoundary (T15.1a): a chunk-load
          failure rejects the lazy promise and must hit the boundary. */}
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppShell />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/expenses" element={<Expenses />} />
              <Route path="/month" element={<Month />} />
              <Route path="/report" element={<Report />} />
              <Route path="/debts" element={<Debts />} />
              <Route path="/recurring" element={<Recurring />} />
              <Route path="/budget" element={<Budget />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
