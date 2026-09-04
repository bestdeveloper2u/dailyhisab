import { BRAND_NAME, t } from "@khoroch/core";
import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const LOGO_SIZE = 44;

/** Bengali-first login screen wired to POST /api/v1/auth/login. */
export default function Login() {
  const auth = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (e.g. deep link to /login) → straight to the dashboard.
  if (auth.user) {
    return <Redirect href="/" />;
  }

  const canSubmit =
    email.trim().length > 0 && password.length > 0 && !pending && !auth.loading;

  async function handleSubmit() {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await auth.login(email.trim(), password);
      router.replace("/");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError(STRINGS.bn.errBadCreds);
        } else if (err.status === 0) {
          setError(STRINGS.bn.errNetwork);
        } else {
          setError(err.message || STRINGS.bn.errGeneric);
        }
      } else {
        setError(STRINGS.bn.errGeneric);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.logoBox}>
        <Text style={styles.logoGlyph}>৳</Text>
      </View>
      <Text style={styles.brand}>{BRAND_NAME}</Text>
      <Text style={styles.tagline}>{t("bn", "tagline")}</Text>

      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder={t("bn", "email")}
          placeholderTextColor={theme.colors.muted}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          editable={!pending}
        />
        <TextInput
          style={styles.input}
          placeholder={t("bn", "password")}
          placeholderTextColor={theme.colors.muted}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          editable={!pending}
        />
        <Pressable
          style={({ pressed }) => [
            styles.button,
            (pending || !canSubmit) && styles.buttonDisabled,
            pressed && canSubmit && styles.buttonPressed,
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel={t("bn", "loginBtn")}
        >
          <Text style={styles.buttonLabel}>
            {pending ? STRINGS.bn.signingIn : t("bn", "loginBtn")}
          </Text>
        </Pressable>
        {error !== null && <Text style={styles.errorText}>{error}</Text>}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.ivory,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  logoBox: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: theme.radius.logo, // ~30% of the 44px mark
    backgroundColor: theme.colors.emerald,
    alignItems: "center",
    justifyContent: "center",
  },
  logoGlyph: {
    color: theme.colors.onAccent,
    fontSize: 24,
    fontWeight: "700",
  },
  brand: {
    color: theme.colors.ink,
    fontSize: 24,
    fontWeight: "700",
  },
  tagline: {
    color: theme.colors.muted,
    fontSize: 14,
  },
  form: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    marginTop: theme.spacing.md,
    gap: theme.spacing.md,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.ink,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    fontSize: 15,
  },
  button: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  buttonLabel: {
    color: theme.colors.onAccent,
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 13,
    textAlign: "center",
  },
});
