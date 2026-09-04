import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";

import { AuthProvider, useAuth } from "../lib/auth";
import { theme } from "../lib/theme";

function RootNavigator() {
  const { loading } = useAuth();

  // Session hydration (SecureStore + /me) in flight → themed blank splash.
  if (loading) {
    return <View style={styles.splash} />;
  }

  return (
    <>
      <StatusBar style="dark" backgroundColor={theme.colors.ivory} />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: theme.colors.ivory,
  },
});
