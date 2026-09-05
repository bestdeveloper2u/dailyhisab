import { Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useAuthStore } from "./store/auth";
import { Budget } from "./screens/Budget";
import { Dashboard } from "./screens/Dashboard";
import { Debts } from "./screens/Debts";
import { Expenses } from "./screens/Expenses";
import { Login } from "./screens/Login";
import { Report } from "./screens/Report";
import { Settings } from "./screens/Settings";

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
  return <Outlet />;
}

/**
 * Route tree. BrowserRouter is provided once in main.tsx so that every
 * component here stays MemoryRouter-compatible for tests.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/report" element={<Report />} />
            <Route path="/debts" element={<Debts />} />
            <Route path="/budget" element={<Budget />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
