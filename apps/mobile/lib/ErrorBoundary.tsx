import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { usePrefs } from "./prefs";
import type { Lang } from "./strings";
import type { ThemeColors } from "./theme";
import { theme } from "./theme";

/**
 * Crash resilience (T13.2), mobile twin of the web ErrorBoundary. React
 * Native crashes to a red screen on any uncaught render error — only a class
 * component with getDerivedStateFromError + componentDidCatch can catch one.
 * Mounted inside PrefsProvider (below the providers, around the navigator)
 * so the fallback reads live theme tokens and the active language.
 *
 * Copy is local to this file (bn + en) — lib/strings.ts belongs to another
 * owner and the crash screen must not depend on it.
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

/** Self-contained fallback: tokens + copy only, no screen/shared components. */
function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { colors, lang } = usePrefs();
  const copy = COPY[lang];
  return (
    <View style={[styles.screen, { backgroundColor: colors.ivory }]}>
      <View
        style={[
          styles.card,
          { backgroundColor: colors.surface, borderColor: colors.line },
        ]}
      >
        <Text style={[styles.title, { color: colors.ink }]}>{copy.title}</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          {copy.subtitle}
        </Text>
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={copy.retry}
          style={({ pressed }) => [
            styles.retryButton,
            { backgroundColor: colors.emerald },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.retryLabel, { color: colors.onAccent }]}>
            {copy.retry}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

/** Same contract as the web boundary: reset re-renders the original tree. */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Real stack in Metro logs; the UI shows the branded retry card.
    console.error("[ErrorBoundary] render error:", error, info.componentStack);
  }

  private readonly reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error !== null) {
      return <ErrorFallback onRetry={this.reset} />;
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    alignItems: "center",
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    marginTop: theme.spacing.sm,
    fontSize: 14,
    textAlign: "center",
  },
  retryButton: {
    alignSelf: "stretch",
    alignItems: "center",
    borderRadius: theme.radius.control,
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.lg,
  },
  pressed: {
    opacity: 0.85,
  },
  retryLabel: {
    fontSize: 15,
    fontWeight: "700",
  },
});
