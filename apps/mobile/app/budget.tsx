import { formatTaka, moneyFromNumber, t as tCore } from "@khoroch/core";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  getBudget,
  putBudget,
  type Budget,
  type BudgetCatUsage,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { hapticSuccess, hapticWarning } from "../lib/haptics";
import { useAuth } from "../lib/auth";
import { usePrefs } from "../lib/prefs";
import { STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";
import { useToast } from "../lib/toast";

/** ^\d+([.]\d{1,2})?$ — mirrors the API's numeric(12,2) domain. */
const AMOUNT_RE = /^\d+([.]\d{1,2})?$/;
const YM_RE = /^\d{4}-\d{2}$/;

/** "YYYY-MM" for the current month, UTC — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Shift "YYYY-MM" by `delta` months using UTC math (no TZ drift). */
function shiftYm(ym: string, delta: number): string {
  if (!YM_RE.test(ym)) return currentYm();
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/**
 * Progress-bar color state: normal / warning ≥80% / danger >100%.
 * The raw percentage drives color + label; the BAR width is clamped to
 * 0–100 by the caller (owner watch item: the fill must never overflow).
 */
function usageColor(rawPct: number): string {
  if (rawPct > 100) return theme.colors.danger;
  if (rawPct >= 80) return theme.colors.warning;
  return theme.colors.emerald;
}

/** Clamp any usage percentage to 0–100 for bar WIDTH only. */
function clampedPct(rawPct: number): number {
  if (!Number.isFinite(rawPct)) return 0;
  return Math.max(0, Math.min(100, rawPct));
}

/** Badge text for a usage percentage (prototype's ভালো/সতর্ক/সীমা ছাড়িয়ে). */
function usageStatus(rawPct: number): string {
  if (rawPct > 100) return STRINGS.bn.budgetStatusOver;
  if (rawPct >= 80) return STRINGS.bn.budgetStatusWarn;
  return STRINGS.bn.budgetStatusOk;
}

/**
 * Budget (T10.1): month switcher, monthly limit upsert, usage card with a
 * clamped 0–100% progress bar (color states at ≥80% / >100%), and
 * per-category rows with inline limit editing — against /api/v1/budgets.
 */
export default function BudgetScreen() {
  const auth = useAuth();
  const { t } = usePrefs();
  const toast = useToast();

  const [ym, setYm] = useState(currentYm);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Monthly limit form.
  const [limitText, setLimitText] = useState("");
  const [limitPending, setLimitPending] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);

  // Inline per-category limit edit.
  const [editingCat, setEditingCat] = useState<string | null>(null);
  const [catText, setCatText] = useState("");
  const [catPending, setCatPending] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  // Guard against out-of-order responses (focus racing month flips).
  const seq = useRef(0);

  // Save feedback (T15.2): both the monthly-limit and per-category save
  // paths land here — one themed toast replaces the old inline flash note.
  const flashSaved = useCallback(() => {
    void hapticSuccess(); // T26.3 — both save paths land here
    toast(t("toastBudgetSaved"));
  }, [t, toast]);

  const load = useCallback(
    async (month: string, viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const data = await getBudget(token, month);
        if (seq.current !== mine) return;
        setBudget(data);
        setLimitText(data.total);
      } catch (err) {
        if (seq.current === mine) setError(describeApiError(err));
      } finally {
        if (seq.current === mine) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [auth.accessToken],
  );

  // Reload on focus and whenever the viewed month changes.
  useFocusEffect(
    useCallback(() => {
      void load(ym, false);
    }, [load, ym]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  const safeBudget = budget; // null → sensible defaults below, no crash.
  const total = safeBudget?.total ?? "0.00";
  const spent = safeBudget?.spent ?? "0.00";
  const rawUsage = safeBudget?.usage_pct ?? 0;
  const totalNum = Number(total);
  const hasLimit = Number.isFinite(totalNum) && totalNum > 0;

  const normalizedLimit = limitText.trim().replace(/^৳\s*/, "");
  const validLimit =
    AMOUNT_RE.test(normalizedLimit) && Number(normalizedLimit) > 0;
  const canSaveLimit = validLimit && !limitPending;

  // Sorted high→low usage; falls back gracefully for empty/missing by_cat.
  const catRows: [string, BudgetCatUsage][] =
    safeBudget === null
      ? []
      : Object.entries(safeBudget.by_cat).sort(
          ([, a], [, b]) => (b.usage_pct ?? 0) - (a.usage_pct ?? 0),
        );

  async function handleSaveLimit() {
    const token = auth.accessToken;
    if (!canSaveLimit || !token) return;
    setLimitPending(true);
    setLimitError(null);
    try {
      await putBudget(token, { total: moneyFromNumber(Number(normalizedLimit)) });
      // PUT returns the GET view for the CURRENT month — refetch the
      // viewed month so usage stays truthful.
      await load(ym, false);
      flashSaved();
    } catch (err) {
      setLimitError(describeApiError(err));
      void hapticWarning(); // T26.3
    } finally {
      setLimitPending(false);
    }
  }

  function openCatEdit(cat: string) {
    setEditingCat(cat);
    setCatText(safeBudget?.cats?.[cat] ?? "");
    setCatError(null);
  }

  function closeCatEdit() {
    setEditingCat(null);
    setCatText("");
    setCatError(null);
  }

  async function handleSaveCat() {
    const token = auth.accessToken;
    const cat = editingCat;
    if (cat === null || catPending || !token) return;
    const normalized = catText.trim().replace(/^৳\s*/, "");
    if (!AMOUNT_RE.test(normalized) || Number(normalized) <= 0) {
      setCatError(STRINGS.bn.errBudgetLimit);
      void hapticWarning(); // T26.3
      return;
    }
    setCatPending(true);
    setCatError(null);
    try {
      // cats REPLACES the whole map — send the full merged map.
      const merged = { ...(safeBudget?.cats ?? {}), [cat]: moneyFromNumber(Number(normalized)) };
      await putBudget(token, { cats: merged });
      closeCatEdit();
      await load(ym, false);
      flashSaved();
    } catch (err) {
      setCatError(describeApiError(err));
      void hapticWarning(); // T26.3
    } finally {
      setCatPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.brand}>{STRINGS.bn.budgetTitle}</Text>
        <Text style={styles.headerHint}>{STRINGS.bn.budgetMonth}</Text>
        <View style={styles.monthRow}>
          <Pressable
            style={({ pressed }) => [
              styles.monthButton,
              pressed && styles.monthButtonPressed,
            ]}
            onPress={() => setYm((prev) => shiftYm(prev, -1))}
            accessibilityRole="button"
            accessibilityLabel={STRINGS.bn.prevMonth}
          >
            <Text style={styles.monthButtonLabel}>◀</Text>
          </Pressable>
          <Text style={styles.monthText}>{ym}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.monthButton,
              pressed && styles.monthButtonPressed,
            ]}
            onPress={() => setYm((prev) => shiftYm(prev, 1))}
            accessibilityRole="button"
            accessibilityLabel={STRINGS.bn.nextMonth}
          >
            <Text style={styles.monthButtonLabel}>▶</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(ym, true)}
            tintColor={theme.colors.emerald}
          />
        }
      >
        {error !== null ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              style={({ pressed }) => [
                styles.retryButton,
                pressed && styles.retryButtonPressed,
              ]}
              onPress={() => void load(ym, false)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.retry}
            >
              <Text style={styles.retryLabel}>{STRINGS.bn.retry}</Text>
            </Pressable>
          </View>
        ) : loading ? (
          <Text style={styles.centerNote}>{STRINGS.bn.budgetLoading}</Text>
        ) : (
          <>
            {/* Usage card — clamped progress bar, color states by raw %. */}
            <View style={styles.usageCard}>
              <View style={styles.usageTop}>
                <Text style={styles.usageLabel}>{STRINGS.bn.budgetSpent}</Text>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: usageSoft(rawUsage) },
                  ]}
                >
                  <Text style={[styles.statusLabel, { color: usageColor(rawUsage) }]}>
                    {usageStatus(rawUsage)}
                  </Text>
                </View>
              </View>
              <Text style={styles.usageAmt} numberOfLines={1}>
                {formatTaka(spent, "bn")}
              </Text>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    { width: `${clampedPct(rawUsage)}%`, backgroundColor: usageColor(rawUsage) },
                  ]}
                />
              </View>
              <Text style={styles.usageMeta}>
                {hasLimit
                  ? `${STRINGS.bn.budgetUsed} ${Math.round(rawUsage)}% · ${STRINGS.bn.budgetSpent} ${formatTaka(spent, "bn")} / ${formatTaka(total, "bn")}`
                  : STRINGS.bn.budgetNoLimit}
              </Text>
            </View>

            {/* Monthly limit form (PUT upsert). */}
            <View style={styles.card}>
              <Text style={styles.label}>{STRINGS.bn.budgetLimit}</Text>
              <TextInput
                style={styles.input}
                placeholder={STRINGS.bn.budgetLimitPlaceholder}
                placeholderTextColor={theme.colors.muted}
                value={limitText}
                onChangeText={setLimitText}
                keyboardType="decimal-pad"
                editable={!limitPending}
              />
              <Pressable
                style={({ pressed }) => [
                  styles.saveButton,
                  (!canSaveLimit || pressed) && styles.saveButtonDisabled,
                ]}
                onPress={() => void handleSaveLimit()}
                disabled={!canSaveLimit}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.save}
              >
                <Text style={styles.saveLabel}>
                  {limitPending ? STRINGS.bn.saving : STRINGS.bn.save}
                </Text>
              </Pressable>
              {!validLimit && limitText.length > 0 && (
                <Text style={styles.hintError}>{STRINGS.bn.errBudgetLimit}</Text>
              )}
              {limitError !== null && (
                <Text style={styles.hintError}>{limitError}</Text>
              )}
            </View>

            {/* Per-category rows: spent vs limit + inline limit edit. */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>{STRINGS.bn.budgetCats}</Text>
              {catRows.length === 0 ? (
                <Text style={styles.emptyNote}>{STRINGS.bn.budgetNoCats}</Text>
              ) : (
                catRows.map(([cat, usage]) => (
                  <View style={styles.catRow} key={cat}>
                    <View style={styles.catMain}>
                      <View style={styles.catTop}>
                        <Text style={styles.catName} numberOfLines={1}>
                          {cat}
                        </Text>
                        <Text style={styles.catAmts}>
                          {formatTaka(usage.spent, "bn")}
                          {" / "}
                          {Number(usage.budget) > 0
                            ? formatTaka(usage.budget, "bn")
                            : STRINGS.bn.budgetNoCatLimit}
                        </Text>
                      </View>
                      <View style={styles.barTrackSmall}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              width: `${clampedPct(usage.usage_pct)}%`,
                              backgroundColor: usageColor(usage.usage_pct),
                            },
                          ]}
                        />
                      </View>
                      {editingCat === cat ? (
                        <View style={styles.catEditBox}>
                          <TextInput
                            style={styles.input}
                            placeholder={STRINGS.bn.budgetLimitPlaceholder}
                            placeholderTextColor={theme.colors.muted}
                            value={catText}
                            onChangeText={setCatText}
                            keyboardType="decimal-pad"
                            editable={!catPending}
                            autoFocus
                          />
                          <View style={styles.catActions}>
                            <Pressable
                              style={({ pressed }) => [
                                styles.catSave,
                                (catPending || pressed) && styles.saveButtonDisabled,
                              ]}
                              onPress={() => void handleSaveCat()}
                              disabled={catPending}
                              accessibilityRole="button"
                              accessibilityLabel={STRINGS.bn.save}
                            >
                              <Text style={styles.catSaveLabel}>
                                {catPending ? STRINGS.bn.saving : STRINGS.bn.save}
                              </Text>
                            </Pressable>
                            <Pressable
                              style={({ pressed }) => [
                                styles.catCancel,
                                pressed && styles.catCancelPressed,
                              ]}
                              onPress={closeCatEdit}
                              disabled={catPending}
                              accessibilityRole="button"
                              accessibilityLabel={STRINGS.bn.cancel}
                            >
                              <Text style={styles.catCancelLabel}>
                                {STRINGS.bn.cancel}
                              </Text>
                            </Pressable>
                          </View>
                          {catError !== null && (
                            <Text style={styles.hintError}>{catError}</Text>
                          )}
                        </View>
                      ) : (
                        <Pressable
                          style={({ pressed }) => [
                            styles.catEditButton,
                            pressed && styles.catEditButtonPressed,
                          ]}
                          onPress={() => openCatEdit(cat)}
                          accessibilityRole="button"
                          accessibilityLabel={`${STRINGS.bn.budgetEditCatLimit} ${cat}`}
                        >
                          <Text style={styles.catEditLabel}>
                            {STRINGS.bn.budgetEditCatLimit}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.backButtonPressed,
          ]}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={tCore("bn", "navDashboard")}
        >
          <Text style={styles.backLabel}>← {tCore("bn", "navDashboard")}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Soft background matching each usage color state. */
function usageSoft(rawPct: number): string {
  if (rawPct > 100) return theme.colors.dangerSoft;
  if (rawPct >= 80) return theme.colors.warningSoft;
  return theme.colors.emeraldSoft;
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
    paddingBottom: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.xs,
  },
  brand: {
    color: theme.colors.onAccent,
    fontSize: 22,
    fontWeight: "700",
  },
  headerHint: {
    color: theme.colors.emeraldSoft,
    fontSize: 13,
  },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    marginTop: theme.spacing.xs,
  },
  monthButton: {
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  monthButtonPressed: {
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  monthButtonLabel: {
    color: theme.colors.onAccent,
    fontSize: 14,
  },
  monthText: {
    color: theme.colors.onAccent,
    fontSize: 17,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    minWidth: 88,
    textAlign: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  usageCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.xl,
    gap: theme.spacing.sm,
  },
  usageTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  usageLabel: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  statusBadge: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  statusLabel: {
    fontSize: 11,
    fontWeight: "700",
  },
  usageAmt: {
    color: theme.colors.ink,
    fontSize: 30,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.radius.control,
    height: 10,
    overflow: "hidden",
  },
  barTrackSmall: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.radius.control,
    height: 6,
    overflow: "hidden",
    marginTop: theme.spacing.xs,
  },
  barFill: {
    height: "100%",
    borderRadius: theme.radius.control,
  },
  usageMeta: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  label: {
    color: theme.colors.muted,
    fontSize: 13,
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
  saveButton: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.xs,
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveLabel: {
    color: theme.colors.onAccent,
    fontSize: 16,
    fontWeight: "600",
  },
  hintError: {
    color: theme.colors.danger,
    fontSize: 13,
  },
  catRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.line,
    paddingTop: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  catMain: {
    gap: theme.spacing.xs,
  },
  catTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  catName: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  catAmts: {
    color: theme.colors.ink,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  catEditBox: {
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  catActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  catSave: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  catSaveLabel: {
    color: theme.colors.onAccent,
    fontSize: 14,
    fontWeight: "600",
  },
  catCancel: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  catCancelPressed: {
    opacity: 0.8,
  },
  catCancelLabel: {
    color: theme.colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
  catEditButton: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    marginTop: theme.spacing.xs,
  },
  catEditButtonPressed: {
    opacity: 0.8,
  },
  catEditLabel: {
    color: theme.colors.ink,
    fontSize: 12,
    fontWeight: "600",
  },
  emptyNote: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  centerNote: {
    color: theme.colors.muted,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: theme.spacing.xl,
  },
  errorBox: {
    alignItems: "center",
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.xl,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 14,
    textAlign: "center",
  },
  retryButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  retryButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  retryLabel: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
  },
  backButton: {
    alignSelf: "center",
    marginTop: theme.spacing.md,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  backButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  backLabel: {
    color: theme.colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
});
