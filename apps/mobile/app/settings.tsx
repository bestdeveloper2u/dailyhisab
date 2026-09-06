import { BRAND_NAME, toBnDigits } from "@khoroch/core";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Redirect, router } from "expo-router";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { exportBackup, parseBackupEnvelope, restoreBackup } from "../lib/api";
import { useAuth } from "../lib/auth";
import { describeApiError } from "../lib/errors";
import { usePrefs } from "../lib/prefs";
import type { Lang } from "../lib/strings";
import type { ThemeColors, ThemeMode } from "../lib/theme";
import { theme } from "../lib/theme";
import { useToast } from "../lib/toast";

/** App version from the Expo config (app.json), with a dev fallback. */
const APP_VERSION = Constants.expoConfig?.version ?? "0.9.0-dev";

/** daily-hisab-backup-YYYYMMDD.json from the device's LOCAL date (T21.3). */
function backupFilename(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `daily-hisab-backup-${now.getFullYear()}${mm}${dd}.json`;
}

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
 * chip, app version, and logout. T21.3 adds the ডেটা নিরাপত্তা card —
 * backup.json download (share sheet) + paste-JSON restore with a two-step
 * confirm. Fully theme-aware — the whole screen restyles live when the
 * theme segment flips, demonstrating both palettes.
 */
export default function Settings() {
  const auth = useAuth();
  const { mode, lang, colors, setMode, setLang, t } = usePrefs();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  // Data-safety card (T21.3): backup download + paste-JSON restore.
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  /**
   * ব্যাকআপ ডাউনলোড (T21.3): GET /export/backup.json → write the envelope
   * to a cache file (exact JSON the server produced — decimal strings stay
   * strings) → OS share sheet. Same terminal-state toast pattern as the
   * list screen's CSV export; must never crash.
   */
  const onBackupDownload = async () => {
    const token = auth.accessToken;
    if (!token || backupBusy) return;
    setBackupBusy(true);
    setRestoreError(null);
    try {
      const envelope = await exportBackup(token);
      const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (dir === null) throw new Error("no-cache-directory");
      const dest = `${dir}${backupFilename(new Date())}`;
      await FileSystem.writeAsStringAsync(
        dest,
        `${JSON.stringify(envelope, null, 2)}\n`,
        { encoding: FileSystem.EncodingType.UTF8 },
      );
      const available = await Sharing.isAvailableAsync();
      if (!available) throw new Error("sharing-unavailable");
      await Sharing.shareAsync(dest, {
        mimeType: "application/json",
        dialogTitle: t("backupDl"),
        UTI: "public.json",
      });
      toast(t("toastBackupDone"));
    } catch {
      toast(t("toastBackupFailed"), "error");
    } finally {
      setBackupBusy(false);
    }
  };

  /** First tap of the two-step restore: arm the destructive flow. */
  const armRestore = () => {
    setRestoreOpen(true);
    setRestoreError(null);
  };

  /** Collapse the restore panel and drop any pasted text. */
  const cancelRestore = () => {
    if (restoreBusy) return;
    setRestoreOpen(false);
    setPasteText("");
    setRestoreError(null);
  };

  /**
   * Second tap of the two-step restore (mirrors the web Settings UX:
   * arm → paste → explicit confirm). Validates the pasted JSON looks like
   * a BackupEnvelope BEFORE the destructive call; parse/network failures
   * surface as a themed inline error — never a crash.
   */
  const onRestoreConfirm = async () => {
    const token = auth.accessToken;
    if (!token || restoreBusy) return;
    const envelope = parseBackupEnvelope(pasteText);
    if (envelope === null) {
      setRestoreError(t("restoreBadJson"));
      return;
    }
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const res = await restoreBackup(token, envelope);
      const count = (n: number) =>
        lang === "bn" ? toBnDigits(String(n)) : String(n);
      toast(
        `${count(res.restored.expenses)} ${t("restoreCountExpenses")}, ${count(
          res.restored.debts,
        )} ${t("restoreCountDebts")} ${t("toastRestoreDone")}`,
      );
      setRestoreOpen(false);
      setPasteText("");
    } catch (err) {
      setRestoreError(describeApiError(err));
    } finally {
      setRestoreBusy(false);
    }
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

        {/* ডেটা নিরাপত্তা (T21.3 — ADR-0012): real backup download + restore,
            mobile parity of the web Settings' DataSafety card. */}
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>
          {t("dataSafety")}
        </Text>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          {/* ব্যাকআপ ডাউনলোড — GET /api/v1/export/backup.json */}
          <View style={styles.dsRow}>
            <View style={styles.dsRowText}>
              <Text
                style={[styles.dsTitle, { color: colors.ink }]}
                numberOfLines={1}
              >
                {t("backupDl")}
              </Text>
              <Text
                style={[styles.dsSub, { color: colors.muted }]}
                numberOfLines={2}
              >
                {t("backupSub")}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.dsButton,
                { backgroundColor: colors.surface2 },
                pressed && styles.dsPressed,
                backupBusy && styles.dsDisabled,
              ]}
              onPress={() => void onBackupDownload()}
              disabled={backupBusy}
              accessibilityRole="button"
              accessibilityLabel={t("backupDl")}
            >
              <Text
                style={[styles.dsButtonLabel, { color: colors.ink }]}
                numberOfLines={1}
              >
                {backupBusy ? t("backupStarted") : t("backupDl")}
              </Text>
            </Pressable>
          </View>

          <View
            style={[styles.dsDivider, { backgroundColor: colors.line }]}
          />

          {/* রিস্টোর — POST /api/v1/import/restore (DESTRUCTIVE: replaces
              the whole ledger). Two-step confirm: first tap arms (opens the
              paste panel with the warning), the danger button confirms —
              the web's arm → confirm UX with a paste box instead of a file
              picker (no new native deps). */}
          <View style={styles.dsRow}>
            <View style={styles.dsRowText}>
              <Text
                style={[styles.dsTitle, { color: colors.ink }]}
                numberOfLines={1}
              >
                {t("restoreTitle")}
              </Text>
              <Text
                style={[styles.dsSub, { color: colors.muted }]}
                numberOfLines={2}
              >
                {t("restoreSub")}
              </Text>
            </View>
            {!restoreOpen && (
              <Pressable
                style={({ pressed }) => [
                  styles.dsButton,
                  { backgroundColor: colors.surface2 },
                  pressed && styles.dsPressed,
                ]}
                onPress={armRestore}
                accessibilityRole="button"
                accessibilityLabel={t("restore")}
              >
                <Text
                  style={[styles.dsButtonLabel, { color: colors.ink }]}
                  numberOfLines={1}
                >
                  {t("restore")}
                </Text>
              </Pressable>
            )}
          </View>

          {restoreOpen && (
            <View style={styles.dsPanel}>
              <Text
                style={[styles.dsWarn, { color: colors.warning }]}
                numberOfLines={3}
              >
                {t("restoreWarn")}
              </Text>
              <TextInput
                style={[
                  styles.dsPaste,
                  {
                    backgroundColor: colors.surface2,
                    borderColor: colors.line,
                    color: colors.ink,
                  },
                ]}
                placeholder={t("pastePlaceholder")}
                placeholderTextColor={colors.muted}
                value={pasteText}
                onChangeText={setPasteText}
                multiline
                textAlignVertical="top"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!restoreBusy}
                accessibilityLabel={t("pastePlaceholder")}
              />
              {restoreError !== null && (
                <Text
                  style={[styles.dsError, { color: colors.danger }]}
                  numberOfLines={2}
                  accessibilityRole="alert"
                >
                  {restoreError}
                </Text>
              )}
              <View style={styles.dsActions}>
                <Pressable
                  style={({ pressed }) => [
                    styles.dsConfirm,
                    { backgroundColor: colors.danger },
                    pressed && styles.dsPressed,
                    restoreBusy && styles.dsDisabled,
                  ]}
                  onPress={() => void onRestoreConfirm()}
                  disabled={restoreBusy}
                  accessibilityRole="button"
                  accessibilityLabel={t("restoreGo")}
                >
                  <Text
                    style={[styles.dsConfirmLabel, { color: colors.ivory }]}
                    numberOfLines={1}
                  >
                    {restoreBusy ? t("restoring") : t("restoreGo")}
                  </Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.dsCancel,
                    pressed && styles.dsPressed,
                    restoreBusy && styles.dsDisabled,
                  ]}
                  onPress={cancelRestore}
                  disabled={restoreBusy}
                  accessibilityRole="button"
                  accessibilityLabel={t("cancel")}
                >
                  <Text
                    style={[styles.dsCancelLabel, { color: colors.muted }]}
                    numberOfLines={1}
                  >
                    {t("cancel")}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
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
  // Data-safety card (T21.3).
  dsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  dsRowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  dsTitle: {
    fontSize: 14,
    fontWeight: "500",
  },
  dsSub: {
    fontSize: 12,
  },
  dsButton: {
    flexShrink: 0,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
  },
  dsButtonLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  dsDivider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: theme.spacing.sm,
  },
  dsPanel: {
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
  },
  dsWarn: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "500",
  },
  dsPaste: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: 13,
    minHeight: 110,
    textAlignVertical: "top",
  },
  dsError: {
    fontSize: 12,
    fontWeight: "600",
  },
  dsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  dsConfirm: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  dsConfirmLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  dsCancel: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  dsCancelLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  dsPressed: {
    opacity: 0.7,
  },
  dsDisabled: {
    opacity: 0.5,
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
