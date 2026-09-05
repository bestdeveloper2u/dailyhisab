import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { t } from "@khoroch/core";
import { Logo } from "../components/Logo";
import { useAuthStore } from "../store/auth";
import { useLangStore } from "../store/lang";
import { l } from "./login.i18n";

const inputClass =
  "rounded-control border border-line bg-ivory px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none";

/**
 * Real auth screen: login via the auth API, with a register toggle that
 * auto-logs-in on success. Backend `{ detail }` messages surface verbatim
 * in an error banner. Demo credentials are seeded by apps/api scripts.
 */
export function Login() {
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Where RequireAuth bounced us from (falls back to the dashboard).
  const from =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const res =
      mode === "login"
        ? await login(email, password)
        : await register({ email, password, name: name.trim() || undefined });

    setPending(false);
    if (res.ok) {
      navigate(from, { replace: true });
    } else {
      setError(res.detail || l(lang, "errFallback"));
    }
  }

  return (
    <main
      className={`flex min-h-dvh items-center justify-center bg-ivory px-4 py-10 text-ink ${
        lang === "bn" ? "font-bn" : "font-en"
      }`}
    >
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 shadow-card">
        <Logo size={44} />
        <p className="mt-2 text-[13px] text-muted">{t(lang, "tagline")}</p>

        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={handleSubmit}
          aria-busy={pending}
        >
          {error && (
            <p
              role="alert"
              className="rounded-control border border-danger bg-danger/5 px-3.5 py-2.5 text-sm font-medium text-danger"
            >
              {error}
            </p>
          )}

          {mode === "register" && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-muted" htmlFor="login-name">
                {l(lang, "name")}
              </label>
              <input
                id="login-name"
                name="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={l(lang, "namePlaceholder")}
                className={inputClass}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted" htmlFor="login-email">
              {t(lang, "email")}
            </label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="demo@khoroch.app"
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted" htmlFor="login-password">
              {t(lang, "password")}
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              minLength={mode === "register" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="demo1234"
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            aria-label={pending ? l(lang, "pending") : undefined}
            className="mt-1 h-12 rounded-control bg-emerald font-bold text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mode === "login" ? t(lang, "loginBtn") : l(lang, "registerBtn")}
          </button>
        </form>

        <p className="mt-3 text-center">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
            className="text-xs font-semibold text-emerald underline-offset-2 hover:underline"
          >
            {mode === "login" ? l(lang, "registerQ") : l(lang, "backToLoginQ")}
          </button>
        </p>

        <p className="mt-4 text-center text-xs text-muted">Demo: demo@khoroch.app / demo1234</p>
      </div>
    </main>
  );
}
