import { BRAND_NAME } from "@khoroch/core";
import Constants from "expo-constants";
import { Redirect, router } from "expo-router";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { useAuth } from "../lib/auth";
import { usePrefs } from "../lib/prefs";
import type { Lang } from "../lib/strings";
import type { ThemeColors, ThemeMode } from "../lib/theme";
import { theme } from "../lib/theme";

/** App version from the Expo config (app.json), with a dev fallback. */
const APP_VERSION = Constants.expoConfig?.version ?? "0.9.0-dev";

interface SegmentOption<T extends string> {
  key: T;
  label: string;
}

/**
 * Prototype's segmented control (.seg): pill container on surface-2, the
 * active option lifts on surface with ink text (www/index.html lines 285–287).
 */
function Segment<T extends string>({
  value,
  options,
  onChange,
  colors,
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (next: T) => void;
  colors: ThemeColors;
}) {
  return (
    <View style={[styles.seg, { backgroundColor: colors.surface2 }]}>
      {options.map((option) => {
        const active = option.key === value;
        return (
          <Pressable
            key={option.key}
            onPress={() => onChange(option.key)}
            style={[
              styles.segButton,
              active && { backgroundColor: colors.surface },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={option.label}
          >
            <Text
              style={[
                styles.segLabel,
                { color: active ? colors.ink : colors.muted },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Prototype's .set-row: label left, value/control right, hairline divider. */
function Row({
  label,
  colors,
  last = false,
  children,
}: {
  label: string;
  colors: ThemeColors;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={[
        styles.row,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: colors.line,
        },
      ]}
    >
      <Text style={[styles.rowLabel, { color: colors.ink }]}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * Settings (T11.3): read-only profile from the auth session (hydrated via
 * GET /auth/me in AuthProvider), language + theme segments, static voice
 * chip, app version, and logout. Fully theme-aware — the whole screen
 * restyles live when the theme segment flips, demonstrating both palettes.
 */
export default function Settings() {
  const auth = useAuth();
  const { mode, lang, colors, setMode, setLang, t } = usePrefs();
  const [pending, setPending] = useState(false);

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  const onLogout = () => {
    if (pending) return;
    setPending(true);
    // auth.logout clears the local session even if the network call fails.
    auth
      .logout()
      .catch(() => undefined)
      .finally(() => router.replace("/login"));
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.ivory }]}>
      <View style={[styles.header, { backgroundColor: colors.emerald }]}>
        <Text style={[styles.title, { color: colors.onAccent }]}>
          {t("settings")}
        </Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>
          {t("profile")}
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <Row label={t("name")} colors={colors}>
            <Text
              style={[styles.rowValue, { color: colors.muted }]}
              numberOfLines={1}
            >
              {auth.user.name ?? "—"}
            </Text>
          </Row>
          <Row label={t("email")} colors={colors}>
            <Text
              style={[styles.rowValue, { color: colors.muted }]}
              numberOfLines={1}
            >
              {auth.user.email}
            </Text>
          </Row>
          <Row label={t("language")} colors={colors}>
            <Segment<Lang>
              value={lang}
              options={[
                { key: "bn", label: t("langBn") },
                { key: "en", label: t("langEn") },
              ]}
              onChange={setLang}
              colors={colors}
            />
          </Row>
          <Row label={t("theme")} colors={colors}>
            <Segment<ThemeMode>
              value={mode}
              options={[
                { key: "light", label: t("light") },
                { key: "dark", label: t("dark") },
              ]}
              onChange={setMode}
              colors={colors}
            />
          </Row>
          <Row label={t("voiceLang")} colors={colors} last>
            <View style={[styles.chip, { backgroundColor: colors.surface2 }]}>
              <Text style={[styles.chipLabel, { color: colors.muted }]}>
                {t("voiceLangValue")}
              </Text>
            </View>
          </Row>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.muted }]}>
          {BRAND_NAME}
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <Row label={t("version")} colors={colors} last>
            <View style={[styles.chip, { backgroundColor: colors.surface2 }]}>
              <Text style={[styles.chipLabel, { color: colors.muted }]}>
                v{APP_VERSION}
              </Text>
            </View>
          </Row>
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.logoutButton,
            { backgroundColor: colors.dangerSoft },
            pressed && styles.logoutButtonPressed,
          ]}
          onPress={onLogout}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel={t("logout")}
        >
          <Text style={[styles.logoutLabel, { color: colors.danger }]}>
            {t("logout")}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    alignItems: "center",
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.xl * 2,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: theme.spacing.sm,
  },
  card: {
    borderRadius: theme.radius.card,
    padding: theme.spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "500",
  },
  rowValue: {
    flexShrink: 1,
    fontSize: 14,
  },
  seg: {
    flexDirection: "row",
    borderRadius: theme.radius.control,
    padding: 3,
    gap: 2,
  },
  segButton: {
    borderRadius: theme.radius.control,
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  segLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  chip: {
    borderRadius: 999, // pill — core RADII has no pill token
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  chipLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  logoutButton: {
    alignSelf: "stretch",
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  logoutButtonPressed: {
    opacity: 0.7,
  },
  logoutLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
});
