import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { AuthProvider, useAuth } from "../lib/auth";
import { ErrorBoundary } from "../lib/ErrorBoundary";
import { PrefsProvider, usePrefs } from "../lib/prefs";
import { maybeRunRecurringBoot } from "../lib/recurringRun";
import { theme } from "../lib/theme";
import { ToastProvider, useToast } from "../lib/toast";

function RootNavigator() {
  const { loading, user, accessToken } = useAuth();
  const { ready, mode, lang, colors } = usePrefs();
  const toast = useToast();

  // T17.1 (ADR-0014 §3): once the bootstrap settles with a live session,
  // materialize due recurring rules — at most one POST per local day per
  // device (SecureStore stamp), fire-and-forget, silent unless created > 0.
  useEffect(() => {
    if (loading || !ready || !user || !accessToken) return;
    void maybeRunRecurringBoot({ accessToken, lang, showToast: toast });
  }, [loading, ready, user, accessToken, lang, toast]);

  // Session hydration (SecureStore + /me) or prefs hydration in flight →
  // themed blank splash (light tokens until prefs resolve).
  if (loading || !ready) {
    return <View style={[styles.splash, { backgroundColor: colors.ivory }]} />;
  }

  return (
    <>
      <StatusBar
        style={mode === "dark" ? "light" : "dark"}
        backgroundColor={colors.ivory}
      />
      <Stack screenOptions={{ headerShown: false }}>
        {/* Explicit registration keeps these routes in the typed manifest. */}
        <Stack.Screen name="list" />
        <Stack.Screen name="month" />
        <Stack.Screen name="report" />
        <Stack.Screen name="budget" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="recurring" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <PrefsProvider>
        {/* T15.2: ToastProvider lives inside PrefsProvider (the pill uses the
            active palette) and wraps everything below so every screen — and
            the error fallback — can call useToast(). */}
        <ToastProvider>
          <ErrorBoundary>
            <RootNavigator />
          </ErrorBoundary>
        </ToastProvider>
      </PrefsProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: theme.colors.ivory,
  },
});
