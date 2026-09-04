import { BRAND_NAME, formatTaka, t } from "@khoroch/core";
import { Redirect } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useAuth } from "../lib/auth";
import { STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const LOGO_SIZE = 44;

/** Signed-in dashboard shell. Auth gate: no user → back to /login. */
export default function Index() {
  const auth = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await auth.logout();
    } finally {
      setSigningOut(false); // unmounts via the Redirect below once user is null
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.logoBox}>
          <Text style={styles.logoGlyph}>৳</Text>
        </View>
        <Text style={styles.brand}>{BRAND_NAME}</Text>
        <Text style={styles.tagline}>{t("bn", "tagline")}</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.card}>
          <Text style={styles.spentLabel}>{STRINGS.bn.account}</Text>
          <Text style={styles.userEmail} numberOfLines={1}>
            {auth.user.email}
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.logoutButton,
              pressed && styles.logoutButtonPressed,
              signingOut && styles.logoutButtonDisabled,
            ]}
            onPress={handleLogout}
            disabled={signingOut}
            accessibilityRole="button"
            accessibilityLabel={t("bn", "logout")}
          >
            <Text style={styles.logoutLabel}>{t("bn", "logout")}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.spentLabel}>{t("bn", "spent")}</Text>
          <Text style={styles.spentAmount}>{formatTaka("4820.00", "bn")}</Text>
        </View>
        <Text style={styles.comingSoon}>{t("bn", "comingSoon")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.ivory,
  },
  header: {
    backgroundColor: theme.colors.emerald,
    alignItems: "center",
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.xl,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  logoBox: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: theme.radius.logo, // ~30% of the 44px mark
    backgroundColor: theme.colors.onAccent,
    alignItems: "center",
    justifyContent: "center",
  },
  logoGlyph: {
    color: theme.colors.emerald,
    fontSize: 24,
    fontWeight: "700",
  },
  brand: {
    color: theme.colors.onAccent,
    fontSize: 24,
    fontWeight: "700",
  },
  tagline: {
    color: theme.colors.emeraldSoft,
    fontSize: 14,
  },
  body: {
    flex: 1,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.xs,
  },
  spentLabel: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  userEmail: {
    color: theme.colors.ink,
    fontSize: 18,
    fontWeight: "600",
  },
  logoutButton: {
    marginTop: theme.spacing.sm,
    alignSelf: "flex-start",
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  logoutButtonPressed: {
    backgroundColor: theme.colors.danger,
  },
  logoutButtonDisabled: {
    opacity: 0.5,
  },
  logoutLabel: {
    color: theme.colors.danger,
    fontSize: 14,
    fontWeight: "600",
  },
  spentAmount: {
    color: theme.colors.ink,
    fontSize: 32,
    fontWeight: "700",
  },
  comingSoon: {
    color: theme.colors.muted,
    fontSize: 12,
    textAlign: "center",
  },
});
