import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";

import { AuthProvider, useAuth } from "../lib/auth";
import { PrefsProvider, usePrefs } from "../lib/prefs";
import { theme } from "../lib/theme";

function RootNavigator() {
  const { loading } = useAuth();
  const { ready, mode, colors } = usePrefs();

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
        <Stack.Screen name="report" />
        <Stack.Screen name="budget" />
        <Stack.Screen name="settings" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <PrefsProvider>
        <RootNavigator />
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
