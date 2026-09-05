/**
 * Global toast (T15.2) — a themed fixed-bottom pill provider.
 *
 * ToastProvider mounts once in app/_layout.tsx INSIDE PrefsProvider so the
 * pill can reuse the active palette (lib/theme.ts tokens — no magic colors,
 * ADR-0003) and every screen can call useToast(). One toast at a time; a new
 * toast replaces the previous one and restarts the auto-dismiss timer.
 *
 * Accessibility parity: the pill is an `alert` with
 * accessibilityLiveRegion="polite" on Android, and the message is also
 * announced via AccessibilityInfo.announceForAccessibility on both platforms.
 */
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from "react-native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { usePrefs } from "./prefs";
import { theme } from "./theme";

export type ToastKind = "success" | "error" | "info";

interface ToastState {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastContextValue {
  showToast(message: string, kind?: ToastKind): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** How long a pill stays on screen. */
const TOAST_VISIBLE_MS = 2600;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { colors } = usePrefs();
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const showToast = useCallback(
    (message: string, kind: ToastKind = "success") => {
      if (message.length === 0) return;
      seq.current += 1;
      setToast({ id: seq.current, message, kind });
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(null), TOAST_VISIBLE_MS);
    },
    [],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // Screen-reader parity with the visual pill (Android live region below).
  useEffect(() => {
    if (toast !== null) {
      AccessibilityInfo.announceForAccessibility(toast.message);
    }
  }, [toast]);

  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);

  const pillColors =
    toast === null
      ? null
      : toast.kind === "success"
        ? { bg: colors.emerald, fg: colors.onAccent }
        : toast.kind === "error"
          ? { bg: colors.danger, fg: colors.ivory }
          : { bg: colors.surface2, fg: colors.ink };

  return (
    <ToastContext.Provider value={value}>
      <View style={styles.host}>
        {children}
        {toast !== null && pillColors !== null && (
          <View
            key={toast.id}
            style={[styles.pill, { backgroundColor: pillColors.bg }]}
            pointerEvents="none"
            accessibilityRole="alert"
            accessibilityLiveRegion={
              Platform.OS === "android" ? "polite" : undefined
            }
          >
            <Text numberOfLines={1} style={[styles.text, { color: pillColors.fg }]}>
              {toast.message}
            </Text>
          </View>
        )}
      </View>
    </ToastContext.Provider>
  );
}

/** Returns a `showToast(message, kind?)` function (kind defaults to success). */
export function useToast(): (message: string, kind?: ToastKind) => void {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx.showToast;
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
  pill: {
    position: "absolute",
    bottom: theme.spacing.xl,
    alignSelf: "center",
    maxWidth: "88%",
    minWidth: 120,
    borderRadius: 999, // pill — core RADII has no pill token (same as settings)
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm + 2,
  },
  text: {
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
});
