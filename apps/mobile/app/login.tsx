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

type AuthMode = "login" | "register";

/** Segment labels for the login/register toggle (prototype authscreen parity). */
const MODES: { key: AuthMode; label: string }[] = [
  { key: "login", label: STRINGS.bn.modeLogin },
  { key: "register", label: STRINGS.bn.modeRegister },
];

/** Bengali-first auth screen: login + register modes (POST /auth/login|register). */
export default function Login() {
  const auth = useAuth();
  const router = useRouter();

  const [mode, setMode] = useState<AuthMode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in (e.g. deep link to /login) → straight to the dashboard.
  if (auth.user) {
    return <Redirect href="/" />;
  }

  const isRegister = mode === "register";
  const canSubmit =
    email.trim().length > 0 && password.length > 0 && !pending && !auth.loading;

  function switchMode(next: AuthMode) {
    if (next === mode) return;
    setMode(next);
    setError(null);
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      if (isRegister) {
        // register() persists the returned pair in lib/auth — the "/" route
        // then lands on the signed-in dashboard exactly like login does.
        await auth.register({
          email: email.trim(),
          password,
          ...(name.trim().length > 0 ? { name: name.trim() } : {}),
        });
      } else {
        await auth.login(email.trim(), password);
      }
      router.replace("/");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 0) {
          setError(STRINGS.bn.errNetwork);
        } else if (isRegister && err.status === 409) {
          setError(STRINGS.bn.errEmailTaken);
        } else if (isRegister && err.status === 422) {
          setError(
            err.message.length > 0 ? err.message : STRINGS.bn.errWeakPassword,
          );
        } else if (!isRegister && err.status === 401) {
          setError(STRINGS.bn.errBadCreds);
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

  const submitLabel = pending
    ? isRegister
      ? STRINGS.bn.registering
      : STRINGS.bn.signingIn
    : isRegister
      ? STRINGS.bn.registerBtn
      : t("bn", "loginBtn");

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
        <View style={styles.modeRow}>
          {MODES.map((m) => (
            <Pressable
              key={m.key}
              style={({ pressed }) => [
                styles.modeChip,
                pressed && styles.modeChipPressed,
                mode === m.key && styles.modeChipSelected,
              ]}
              onPress={() => switchMode(m.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m.key }}
              accessibilityLabel={m.label}
            >
              <Text
                style={[
                  styles.modeChipLabel,
                  mode === m.key && styles.modeChipLabelSelected,
                ]}
              >
                {m.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {isRegister && (
          <TextInput
            style={styles.input}
            placeholder={STRINGS.bn.namePlaceholder}
            placeholderTextColor={theme.colors.muted}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoComplete="name"
            editable={!pending}
          />
        )}
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
          autoComplete={isRegister ? "new-password" : "password"}
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
          accessibilityLabel={submitLabel}
        >
          <Text style={styles.buttonLabel}>{submitLabel}</Text>
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
  modeRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  modeChip: {
    flex: 1,
    alignItems: "center",
    borderRadius: theme.radius.control,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface2,
  },
  modeChipSelected: {
    backgroundColor: theme.colors.emerald,
  },
  modeChipPressed: {
    opacity: 0.8,
  },
  modeChipLabel: {
    color: theme.colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
  modeChipLabelSelected: {
    color: theme.colors.onAccent,
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
