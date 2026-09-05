import { BRAND_NAME, formatTaka, t } from "@khoroch/core";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  monthlyReport,
  yearlyReport,
  type MonthlyReport,
  type YearlyReport,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { GROUP_LABELS, MONTH_LABELS, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

type Mode = "monthly" | "yearly";

const MODES: { key: Mode; label: string }[] = [
  { key: "monthly", label: STRINGS.bn.modeMonthly },
  { key: "yearly", label: STRINGS.bn.modeYearly },
];

const CHART_HEIGHT = 88;

/** "YYYY-MM" for the current month, UTC — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Current year, UTC — the API's ?year= domain and the picker's origin. */
function currentYear(): number {
  return new Date().getUTCFullYear();
}

/** Decimal string → proportion (0..1) of `peak` for bar rendering. */
function barProportion(amt: string, peak: number): number {
  const value = Number(amt);
  if (!Number.isFinite(value) || !Number.isFinite(peak) || peak <= 0) return 0;
  return Math.min(1, Math.max(0, value / peak));
}

/** "2026-03" → "মার্চ" for the by_month chart labels. */
function monthLabel(ym: string): string {
  const idx = Number(ym.slice(5, 7)) - 1;
  return MONTH_LABELS.bn[idx] ?? ym;
}

/**
 * Report (T5.1): monthly + yearly summaries against
 * /api/v1/reports/monthly and /api/v1/reports/yearly.
 * Monthly shows the current month (same domain as the dashboard); yearly has
 * a prev/next year picker and a 12-month mini bar chart (by_month is always
 * 12 ascending zero-filled entries with decimal-string totals).
 */
export default function Report() {
  const auth = useAuth();

  const [mode, setMode] = useState<Mode>("monthly");
  const [year, setYear] = useState<number>(currentYear());
  const [monthly, setMonthly] = useState<MonthlyReport | null>(null);
  const [yearly, setYearly] = useState<YearlyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against out-of-order responses (mode/year racing focus).
  const seq = useRef(0);

  const load = useCallback(
    async (which: Mode, forYear: number, viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        if (which === "monthly") {
          const report = await monthlyReport(token, currentYm());
          if (seq.current === mine) setMonthly(report);
        } else {
          const report = await yearlyReport(token, forYear);
          if (seq.current === mine) setYearly(report);
        }
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

  // Reload on focus AND whenever the mode/year changes (load identity changes).
  useFocusEffect(
    useCallback(() => {
      void load(mode, year, false);
    }, [load, mode, year]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // Sorted high→low for the by-group breakdown; labels fall back to the raw
  // API group name for anything GROUP_LABELS does not know about.
  const groupEntries: [string, string][] =
    mode === "monthly"
      ? monthly === null
        ? []
        : Object.entries(monthly.by_group)
      : yearly === null
        ? []
        : Object.entries(yearly.by_group);
  const groupRows = [...groupEntries].sort(([, a], [, b]) => Number(b) - Number(a));
  const groupMax = groupRows.length > 0 ? Number(groupRows[0][1]) : 0;

  const total =
    mode === "monthly" ? (monthly?.total ?? "0.00") : (yearly?.total ?? "0.00");
  const count = mode === "monthly" ? (monthly?.count ?? 0) : (yearly?.count ?? 0);
  const periodLabel =
    mode === "monthly" ? (monthly?.ym ?? currentYm()) : String(year);
  const isEmpty = Number(total) === 0;

  const monthRows = mode === "yearly" ? (yearly?.by_month ?? []) : [];
  const monthMax = monthRows.reduce((peak, entry) => {
    const value = Number(entry.total);
    return Number.isFinite(value) && value > peak ? value : peak;
  }, 0);

  const thisYear = currentYear();

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.brand}>{BRAND_NAME}</Text>
        <Text style={styles.title}>{STRINGS.bn.reportTitle}</Text>
        <View style={styles.chipRow}>
          {MODES.map((m) => (
            <Chip
              key={m.key}
              label={m.label}
              selected={mode === m.key}
              onPress={() => setMode(m.key)}
            />
          ))}
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(mode, year, true)}
            tintColor={theme.colors.emerald}
          />
        }
      >
        {mode === "yearly" && (
          <View style={styles.yearRow}>
            <Pressable
              style={({ pressed }) => [
                styles.yearArrow,
                pressed && styles.yearArrowPressed,
              ]}
              onPress={() => setYear((prev) => prev - 1)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.prevYear}
            >
              <Text style={styles.yearArrowLabel}>‹</Text>
            </Pressable>
            <Text style={styles.yearValue}>{year}</Text>
            <Pressable
              style={({ pressed }) => [
                styles.yearArrow,
                year >= thisYear && styles.yearArrowDisabled,
                pressed && styles.yearArrowPressed,
              ]}
              onPress={() => setYear((prev) => prev + 1)}
              disabled={year >= thisYear}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.nextYear}
            >
              <Text style={styles.yearArrowLabel}>›</Text>
            </Pressable>
          </View>
        )}

        {error !== null ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              style={({ pressed }) => [
                styles.retryButton,
                pressed && styles.retryButtonPressed,
              ]}
              onPress={() => void load(mode, year, false)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.retry}
            >
              <Text style={styles.retryLabel}>{STRINGS.bn.retry}</Text>
            </Pressable>
          </View>
        ) : loading ? (
          <Text style={styles.centerNote}>{STRINGS.bn.loadingReport}</Text>
        ) : (
          <>
            <View style={styles.totalCard}>
              <Text style={styles.cardLabel}>
                {mode === "monthly"
                  ? STRINGS.bn.monthTotal
                  : STRINGS.bn.yearTotal}
              </Text>
              <Text style={styles.totalAmt}>{formatTaka(total, "bn")}</Text>
              <Text style={styles.cardMeta}>
                {periodLabel} · {count} {STRINGS.bn.monthCount}
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>{STRINGS.bn.byGroup}</Text>
              {groupRows.length === 0 ? (
                <Text style={styles.emptyNote}>
                  {mode === "monthly"
                    ? STRINGS.bn.noExpensesThisMonth
                    : STRINGS.bn.noExpensesThisYear}
                </Text>
              ) : (
                groupRows.map(([grp, amt]) => (
                  <View style={styles.groupRow} key={grp}>
                    <View style={styles.groupLabelRow}>
                      <Text style={styles.groupLabel} numberOfLines={1}>
                        {grp in GROUP_LABELS
                          ? GROUP_LABELS[grp as keyof typeof GROUP_LABELS]
                          : grp}
                      </Text>
                      <Text style={styles.groupAmt}>
                        {formatTaka(amt, "bn")}
                      </Text>
                    </View>
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          { width: `${barProportion(amt, groupMax) * 100}%` },
                        ]}
                      />
                    </View>
                  </View>
                ))
              )}
            </View>

            {mode === "yearly" && monthRows.length > 0 && !isEmpty && (
              <View style={styles.card}>
                <Text style={styles.sectionTitle}>{STRINGS.bn.byMonth}</Text>
                <View style={styles.chartRow}>
                  {monthRows.map((entry) => (
                    <View style={styles.chartCol} key={entry.ym}>
                      <View style={styles.chartTrack}>
                        <View
                          style={[
                            styles.chartFill,
                            {
                              height: `${
                                barProportion(entry.total, monthMax) * 100
                              }%`,
                            },
                          ]}
                        />
                      </View>
                      <Text style={styles.chartLabel} numberOfLines={1}>
                        {monthLabel(entry.ym)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.backButtonPressed,
          ]}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t("bn", "navDashboard")}
        >
          <Text style={styles.backLabel}>← {t("bn", "navDashboard")}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && styles.chipPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
        {label}
      </Text>
    </Pressable>
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
    paddingBottom: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  brand: {
    color: theme.colors.onAccent,
    fontSize: 18,
    fontWeight: "700",
  },
  title: {
    color: theme.colors.onAccent,
    fontSize: 22,
    fontWeight: "700",
  },
  chipRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  chip: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.emeraldSoft,
  },
  chipSelected: {
    backgroundColor: theme.colors.onAccent,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipLabel: {
    color: theme.colors.onAccent,
    fontSize: 14,
    fontWeight: "600",
  },
  chipLabelSelected: {
    color: theme.colors.emerald,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  yearRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.lg,
  },
  yearArrow: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    width: 44,
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
  },
  yearArrowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  yearArrowDisabled: {
    opacity: 0.4,
  },
  yearArrowLabel: {
    color: theme.colors.ink,
    fontSize: 20,
    fontWeight: "700",
  },
  yearValue: {
    color: theme.colors.ink,
    fontSize: 18,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    minWidth: 64,
    textAlign: "center",
  },
  totalCard: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.card,
    padding: theme.spacing.xl,
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  cardLabel: {
    color: theme.colors.emeraldSoft,
    fontSize: 13,
  },
  totalAmt: {
    color: theme.colors.onAccent,
    fontSize: 34,
    fontWeight: "700",
  },
  cardMeta: {
    color: theme.colors.emeraldSoft,
    fontSize: 12,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  sectionTitle: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  groupRow: {
    gap: theme.spacing.xs,
  },
  groupLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  groupLabel: {
    color: theme.colors.ink,
    fontSize: 14,
    flex: 1,
  },
  groupAmt: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: theme.colors.emerald,
  },
  chartRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing.xs,
  },
  chartCol: {
    flex: 1,
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  chartTrack: {
    height: CHART_HEIGHT,
    alignSelf: "stretch",
    justifyContent: "flex-end",
    borderRadius: 3,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  chartFill: {
    minHeight: 2,
    borderRadius: 3,
    backgroundColor: theme.colors.emerald,
  },
  chartLabel: {
    color: theme.colors.muted,
    fontSize: 10,
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
