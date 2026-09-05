/**
 * মাসিক হিসাব (T14.5) — mobile parity of the frozen prototype's screen-month
 * (www/index.html lines 720–757): a 2×2 month-KPI grid (entries / daily avg /
 * max-spend day / top group), a ‹ month › switcher with bn month name, a
 * "মোট মাসিক ব্যয়" total card (৳, en-IN grouping) beside a prev-month
 * comparison card, day-grouped entries for the month, and per-group bars.
 *
 * Data: the KPIs/total/compare/bars come from GET /reports/monthly (current +
 * previous ym in parallel — the same approach as report.tsx T13.1); the
 * day-grouped rows come from GET /expenses?from=<ym>-01&to=<ym>-last with
 * cursor pagination ("আরও দেখুন"). Every request is READ-ONLY.
 */
import { BRAND_NAME, formatTaka, toBnDigits } from "@khoroch/core";
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
  listExpenses,
  monthlyReport,
  type Expense,
  type MonthlyReport,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { GROUP_LABELS, MONTH_NAMES, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const PAGE_SIZE = 50;
const YM_RE = /^\d{4}-\d{2}$/;

/** "YYYY-MM" for the current month, UTC — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Shift "YYYY-MM" by `delta` months using UTC math (same as budget.tsx). */
function shiftYm(ym: string, delta: number): string {
  if (!YM_RE.test(ym)) return currentYm();
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Last calendar day of "YYYY-MM" → "YYYY-MM-DD" (the list ?to= is inclusive). */
function lastDayIso(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, "0")}`;
}

/** "2026-09" → "সেপ্টেম্বর ২০২৬" — the prototype monthName (bn month + bn year). */
function monthNameLabel(ym: string): string {
  if (!YM_RE.test(ym)) return ym;
  const year = ym.slice(0, 4);
  const idx = Number(ym.slice(5, 7)) - 1;
  return `${MONTH_NAMES.bn[idx] ?? ym} ${toBnDigits(year)}`;
}

/** "2026-09-05" → "৫ সেপ্টেম্বর" — day labels for sections + the max-day KPI. */
function dayLabelFromIso(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const name = MONTH_NAMES.bn[(m || 1) - 1] ?? "";
  return `${toBnDigits(String(d ?? ""))} ${name}`;
}

/** API group key → bn label, falling back to the raw name when unknown. */
function groupDisplayLabel(grp: string): string {
  return grp in GROUP_LABELS
    ? GROUP_LABELS[grp as keyof typeof GROUP_LABELS]
    : grp;
}

/**
 * Group share of the month total as a display percentage (prototype `.pc`).
 * Never negative; NaN-safe.
 */
function groupPct(amt: string, total: string): number {
  const base = Number(total);
  const value = Number(amt);
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0) return 0;
  return Math.max(0, (value / base) * 100);
}

/**
 * Bar WIDTH for a group bar — clamped to 0–100 with a 1.5% visibility floor
 * when the group has any spend (prototype: Math.max(w, 1.5) + "%").
 * Owner watch: the fill must never overflow the track.
 */
function barWidthPct(amt: string, total: string): number {
  const pct = groupPct(amt, total);
  if (pct <= 0) return 0;
  return Math.min(100, Math.max(1.5, pct));
}

interface DaySection {
  iso: string;
  entries: Expense[];
}

/** Group rows by event date (ISO day); sections ordered newest→oldest. */
function groupByDay(items: Expense[]): DaySection[] {
  const sections: DaySection[] = [];
  const index = new Map<string, DaySection>();
  for (const expense of items) {
    let section = index.get(expense.iso);
    if (section === undefined) {
      section = { iso: expense.iso, entries: [] };
      index.set(expense.iso, section);
      sections.push(section);
    }
    section.entries.push(expense);
  }
  sections.sort((a, b) => b.iso.localeCompare(a.iso));
  return sections;
}

/**
 * Month screen route: /month (entry affordance on the dashboard).
 */
export default function MonthScreen() {
  const auth = useAuth();

  const [ym, setYm] = useState(currentYm);
  const [monthly, setMonthly] = useState<MonthlyReport | null>(null);
  const [prevMonthly, setPrevMonthly] = useState<MonthlyReport | null>(null);
  const [items, setItems] = useState<Expense[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guard against out-of-order responses (month flips racing focus/pull/loadMore).
  const seq = useRef(0);

  const load = useCallback(
    async (month: string, viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        // All three reads are independent. A prev-month failure must not
        // break the screen — it degrades to the "no prev data" compare state
        // (same graceful behavior as report.tsx T13.1).
        const [report, prev, page] = await Promise.all([
          monthlyReport(token, month),
          monthlyReport(token, shiftYm(month, -1)).catch(() => null),
          listExpenses(token, {
            from: `${month}-01`,
            to: lastDayIso(month),
            limit: PAGE_SIZE,
          }),
        ]);
        if (seq.current !== mine) return;
        setMonthly(report);
        setPrevMonthly(prev);
        setItems(page.items);
        setNextCursor(page.next_cursor);
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

  const loadMore = useCallback(async () => {
    const token = auth.accessToken;
    if (!token || nextCursor === null || loadingMore) return;
    const mine = ++seq.current; // also invalidates when the month flips mid-page
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listExpenses(token, {
        from: `${ym}-01`,
        to: lastDayIso(ym),
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      if (seq.current !== mine) return;
      setItems((prevItems) => [...prevItems, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (seq.current === mine) setMoreError(describeApiError(err));
    } finally {
      if (seq.current === mine) setLoadingMore(false);
    }
  }, [auth.accessToken, nextCursor, loadingMore, ym]);

  // Reload on focus AND whenever the viewed month changes (load identity changes).
  useFocusEffect(
    useCallback(() => {
      void load(ym, false);
    }, [load, ym]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // --- Month KPIs (same math as report.tsx T13.1) ---
  const total = monthly?.total ?? "0.00";
  const count = monthly?.count ?? 0;
  const byDayRows = monthly?.by_day ?? [];
  const daysWithSpend = new Set(byDayRows.map((d) => d.iso)).size;
  const dailyAvgNum =
    monthly !== null && daysWithSpend > 0 ? Number(total) / daysWithSpend : 0;
  const topDay =
    byDayRows.length > 0
      ? byDayRows.reduce((a, b) => (Number(b.total) > Number(a.total) ? b : a))
      : null;

  // Sorted high→low for the bars + top-group KPI.
  const groupRows =
    monthly === null
      ? []
      : Object.entries(monthly.by_group).sort(
          ([, a], [, b]) => Number(b) - Number(a),
        );
  const topGroupEntry =
    groupRows.length > 0 && Number(groupRows[0][1]) > 0 ? groupRows[0] : null;

  // --- Prev-month comparison (prototype prevCmp) ---
  const prevTotalNum = prevMonthly !== null ? Number(prevMonthly.total) : 0;
  const hasPrevData =
    prevMonthly !== null && (prevTotalNum > 0 || prevMonthly.count > 0);
  const cmpDiffNum = hasPrevData ? Number(total) - prevTotalNum : 0;
  // ▼/↓ green = spent less than last month, ▲/↑ red = spent more.
  const cmpDown = cmpDiffNum < 0;
  const cmpPct =
    hasPrevData && prevTotalNum > 0
      ? Math.abs((cmpDiffNum / prevTotalNum) * 100)
      : 0;

  const sections = groupByDay(items);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.brand} numberOfLines={1}>
          {BRAND_NAME}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {STRINGS.bn.monthTitle}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {STRINGS.bn.monthSub}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
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
            <Text style={styles.errorText} numberOfLines={3}>
              {error}
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.retryButton,
                pressed && styles.retryButtonPressed,
              ]}
              onPress={() => void load(ym, false)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.retry}
            >
              <Text style={styles.retryLabel} numberOfLines={1}>
                {STRINGS.bn.retry}
              </Text>
            </Pressable>
          </View>
        ) : loading ? (
          <Text style={styles.centerNote}>{STRINGS.bn.loadingReport}</Text>
        ) : (
          <>
            {/* KPI 2×2 (prototype .kpis) — every value clamped so long
                labels never wrap the card. */}
            <View style={styles.kpiGrid}>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel} numberOfLines={1}>
                  {STRINGS.bn.kpiEntries}
                </Text>
                <Text
                  style={styles.kpiValue}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {toBnDigits(String(count))}
                </Text>
              </View>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel} numberOfLines={1}>
                  {STRINGS.bn.kpiAvg}
                </Text>
                <Text
                  style={styles.kpiValue}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {formatTaka(dailyAvgNum, "bn")}
                </Text>
              </View>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel} numberOfLines={1}>
                  {STRINGS.bn.kpiMaxDay}
                </Text>
                <Text
                  style={styles.kpiValue}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {topDay === null
                    ? "—"
                    : `${dayLabelFromIso(topDay.iso)} · ${formatTaka(
                        topDay.total,
                        "bn",
                      )}`}
                </Text>
              </View>
              <View style={styles.kpiCard}>
                <Text style={styles.kpiLabel} numberOfLines={1}>
                  {STRINGS.bn.kpiMaxGroup}
                </Text>
                <Text
                  style={styles.kpiValue}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {topGroupEntry === null
                    ? "—"
                    : `${groupDisplayLabel(topGroupEntry[0])} · ${formatTaka(
                        topGroupEntry[1],
                        "bn",
                      )}`}
                </Text>
              </View>
            </View>

            {/* Month switcher (prototype .month-switch): ‹ monthName ›. */}
            <View style={styles.monthRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.monthArrow,
                  pressed && styles.monthArrowPressed,
                ]}
                onPress={() => setYm((prev) => shiftYm(prev, -1))}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.prevMonth}
              >
                <Text style={styles.monthArrowLabel}>‹</Text>
              </Pressable>
              <Text style={styles.monthName} numberOfLines={1}>
                {monthNameLabel(ym)}
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.monthArrow,
                  pressed && styles.monthArrowPressed,
                ]}
                onPress={() => setYm((prev) => shiftYm(prev, 1))}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.nextMonth}
              >
                <Text style={styles.monthArrowLabel}>›</Text>
              </Pressable>
            </View>

            {/* Total card (prototype .total-card) — ৳ with en-IN grouping. */}
            <View style={styles.totalCard}>
              <Text style={styles.cardLabel} numberOfLines={1}>
                {STRINGS.bn.monthTotalCard}
              </Text>
              <Text
                style={styles.totalAmt}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {formatTaka(total, "en")}
              </Text>
            </View>

            {/* Prev-month comparison (prototype #prevCmp). */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle} numberOfLines={1}>
                {STRINGS.bn.cmpPrevTitle}
              </Text>
              {!hasPrevData || prevMonthly === null ? (
                <Text style={styles.emptyNote} numberOfLines={2}>
                  {STRINGS.bn.cmpNoPrev}
                </Text>
              ) : (
                <>
                  <View style={styles.cmpRow}>
                    <Text style={styles.cmpLabel} numberOfLines={1}>
                      {STRINGS.bn.cmpThis} · {monthNameLabel(ym)}
                    </Text>
                    <Text
                      style={styles.cmpAmt}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {formatTaka(total, "bn")}
                    </Text>
                  </View>
                  <View style={styles.cmpRow}>
                    <Text style={styles.cmpLabel} numberOfLines={1}>
                      {STRINGS.bn.cmpPrev} · {monthNameLabel(shiftYm(ym, -1))}
                    </Text>
                    <Text
                      style={styles.cmpAmt}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {formatTaka(prevMonthly.total, "bn")}
                    </Text>
                  </View>
                  <View style={[styles.cmpRow, styles.cmpRowDiff]}>
                    <Text style={styles.cmpLabel} numberOfLines={1}>
                      {STRINGS.bn.cmpDiff}
                    </Text>
                    <Text
                      style={[
                        styles.cmpAmt,
                        {
                          color: cmpDown
                            ? theme.colors.emerald
                            : theme.colors.danger,
                        },
                      ]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {cmpDown ? "↓" : "↑"}{" "}
                      {formatTaka(Math.abs(cmpDiffNum), "bn")} ·{" "}
                      {toBnDigits(cmpPct.toFixed(1))}%{" "}
                      {cmpDown ? STRINGS.bn.cmpLess : STRINGS.bn.cmpMore}
                    </Text>
                  </View>
                  <View style={styles.cmpRow}>
                    <Text style={styles.cmpLabel} numberOfLines={1}>
                      {STRINGS.bn.cmpEntries}
                    </Text>
                    <Text
                      style={styles.cmpAmt}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {toBnDigits(String(count))} /{" "}
                      {toBnDigits(String(prevMonthly.count))}
                    </Text>
                  </View>
                </>
              )}
            </View>

            {/* Day-grouped entries (prototype #monthRows). */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle} numberOfLines={1}>
                {STRINGS.bn.allEntries}
              </Text>
              {sections.length === 0 ? (
                <Text style={styles.emptyNote} numberOfLines={2}>
                  {STRINGS.bn.noExpensesThisMonth}
                </Text>
              ) : (
                <>
                  {sections.map((section) => (
                    <View key={section.iso} style={styles.daySection}>
                      <Text style={styles.dayLabel} numberOfLines={1}>
                        {dayLabelFromIso(section.iso)}
                      </Text>
                      {section.entries.map((expense) => (
                        <View style={styles.row} key={expense.id}>
                          <View style={styles.rowMain}>
                            <Text style={styles.rowCat} numberOfLines={1}>
                              {expense.cat}
                            </Text>
                            {expense.desc !== null && expense.desc !== "" && (
                              <Text style={styles.rowDesc} numberOfLines={1}>
                                {expense.desc}
                              </Text>
                            )}
                          </View>
                          <Text
                            style={styles.rowAmt}
                            numberOfLines={1}
                            ellipsizeMode="tail"
                          >
                            {formatTaka(expense.amt, "bn")}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ))}
                  {moreError !== null && (
                    <Text style={styles.emptyNote} numberOfLines={2}>
                      {moreError}
                    </Text>
                  )}
                  {nextCursor !== null && (
                    <Pressable
                      style={({ pressed }) => [
                        styles.moreButton,
                        pressed && styles.moreButtonPressed,
                        loadingMore && styles.moreButtonDisabled,
                      ]}
                      onPress={() => void loadMore()}
                      disabled={loadingMore}
                      accessibilityRole="button"
                      accessibilityLabel={STRINGS.bn.loadMore}
                    >
                      <Text style={styles.moreButtonLabel} numberOfLines={1}>
                        {loadingMore
                          ? STRINGS.bn.loadingMore
                          : STRINGS.bn.loadMore}
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
            </View>

            {/* Group bars (prototype #groupBars): share of month total,
                bar width clamped to 0–100. */}
            <View style={styles.card}>
              <Text style={styles.sectionTitle} numberOfLines={1}>
                {STRINGS.bn.byGroup}
              </Text>
              {groupRows.length === 0 ? (
                <Text style={styles.emptyNote} numberOfLines={2}>
                  {STRINGS.bn.noExpensesThisMonth}
                </Text>
              ) : (
                groupRows.map(([grp, amt]) => (
                  <View style={styles.groupRow} key={grp}>
                    <View style={styles.groupLabelRow}>
                      <Text style={styles.groupLabel} numberOfLines={1}>
                        {groupDisplayLabel(grp)}
                      </Text>
                      <Text style={styles.groupPct} numberOfLines={1}>
                        {toBnDigits(groupPct(amt, total).toFixed(1))}%
                      </Text>
                      <Text
                        style={styles.groupAmt}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {formatTaka(amt, "bn")}
                      </Text>
                    </View>
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.barFill,
                          { width: `${barWidthPct(amt, total)}%` },
                        ]}
                      />
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
          accessibilityLabel={STRINGS.bn.openDashboard}
        >
          <Text style={styles.backLabel} numberOfLines={1}>
            ← {STRINGS.bn.openDashboard}
          </Text>
        </Pressable>
      </ScrollView>
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
    paddingBottom: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
    gap: theme.spacing.xs,
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
  subtitle: {
    color: theme.colors.emeraldSoft,
    fontSize: 13,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  // 2×2 KPI grid (prototype .kpis) — two cards per row via wrap.
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  kpiCard: {
    flexGrow: 1,
    flexBasis: "46%",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  kpiLabel: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  kpiValue: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  // Month switcher (prototype .month-switch).
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing.lg,
  },
  monthArrow: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    width: 44,
    alignItems: "center",
    paddingVertical: theme.spacing.sm,
  },
  monthArrowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  monthArrowLabel: {
    color: theme.colors.ink,
    fontSize: 20,
    fontWeight: "700",
  },
  monthName: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
    flexShrink: 1,
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
    fontVariant: ["tabular-nums"],
    maxWidth: "100%",
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
  // Prev-month comparison rows (prototype .cmprow).
  cmpRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  cmpRowDiff: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.line,
    paddingTop: theme.spacing.sm,
  },
  cmpLabel: {
    color: theme.colors.muted,
    fontSize: 13,
    flex: 1,
  },
  cmpAmt: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
    flexShrink: 1,
  },
  // Day-grouped rows (same pattern as list.tsx).
  daySection: {
    gap: theme.spacing.sm,
  },
  dayLabel: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  row: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md + 2,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
  rowCat: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "600",
  },
  rowDesc: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  rowAmt: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  moreButton: {
    alignSelf: "center",
    backgroundColor: theme.colors.emeraldSoft,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  moreButtonPressed: {
    opacity: 0.8,
  },
  moreButtonDisabled: {
    opacity: 0.5,
  },
  moreButtonLabel: {
    color: theme.colors.emerald,
    fontSize: 14,
    fontWeight: "700",
  },
  // Group bars (prototype .gbar-row/.gbar).
  groupRow: {
    gap: theme.spacing.xs,
  },
  groupLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  groupLabel: {
    color: theme.colors.ink,
    fontSize: 14,
    flex: 1,
  },
  groupPct: {
    color: theme.colors.muted,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  groupAmt: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    flexShrink: 1,
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
