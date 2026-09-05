import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Lang } from "@khoroch/core";
import { useLangStore } from "../store/lang";

/**
 * Crash resilience (T13.2). React has no functional equivalent for catching
 * render-time exceptions — only a class component with
 * getDerivedStateFromError + componentDidCatch can — so without this boundary
 * any render error white-screens the app. The fallback reuses the brand
 * tokens (ivory/surface/ink/muted/line/emerald) so a crash renders as a
 * themed retry card instead of a blank page.
 *
 * All copy is local to this file (bn + en): lib strings belong to their own
 * owners and the crash screen must not depend on a module that could itself
 * be part of the failure.
 */
const COPY: Record<Lang, { title: string; subtitle: string; retry: string }> = {
  bn: {
    title: "কিছু একটা ভুল হয়েছে",
    subtitle: "অ্যাপে অপ্রত্যাশিত একটি সমস্যা হয়েছে। আবার চেষ্টা করে দেখুন।",
    retry: "আবার চেষ্টা করুন",
  },
  en: {
    title: "Something went wrong",
    subtitle: "The app hit an unexpected error. Please try again.",
    retry: "Try again",
  },
};

/** Read the persisted UI language without hooks — legal inside class render. */
function currentLang(): Lang {
  try {
    return useLangStore.getState().lang;
  } catch {
    // Store unavailable → Bengali-first default (matches the app default).
    return "bn";
  }
}

/**
 * The fallback is deliberately dependency-free (no Logo, no child modules) so
 * it can render even when the failure originated inside a shared component.
 * Plain render function (not a component) — keeps this file single-component
 * for react-refresh, and it uses no hooks by design.
 */
function renderErrorFallback(onRetry: () => void) {
  const lang = currentLang();
  const copy = COPY[lang];
  return (
    <div
      role="alert"
      className={`flex min-h-dvh items-center justify-center bg-ivory px-4 py-10 text-ink ${
        lang === "bn" ? "font-bn" : "font-en"
      }`}
    >
      <div className="w-full max-w-sm rounded-card border border-line bg-surface p-6 text-center shadow-card">
        <h1 className="text-lg font-bold">{copy.title}</h1>
        <p className="mt-2 text-sm text-muted">{copy.subtitle}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 h-12 w-full rounded-control bg-emerald font-bold text-accent-ink transition-[filter] hover:brightness-110"
        >
          {copy.retry}
        </button>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Route-tree-wide boundary. Wrap once around <Routes> in App.tsx; "Try again"
 * clears the error state, which re-renders the original children.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the real stack in devtools/crash reports; UI stays branded.
    console.error("[ErrorBoundary] render error:", error, info.componentStack);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error !== null) {
      return renderErrorFallback(this.reset);
    }
    return this.props.children;
  }
}
