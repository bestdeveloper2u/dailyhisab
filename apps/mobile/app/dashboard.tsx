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
  listExpenses,
  monthlyReport,
  type Expense,
  type MonthlyReport,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { GROUP_LABELS, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const RECENT_LIMIT = 5;

/** "YYYY-MM" for the current month, UTC — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Dashboard (T3.4): current-month total + per-group breakdown from
 * GET /api/v1/reports/monthly, plus the most recent expenses from
 * GET /api/v1/expenses (first page only — the full list lives on /).
 */
export default function Dashboard() {
  const auth = useAuth();

  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [recent, setRecent] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guard against out-of-order responses (focus racing pull-to-refresh).
  const seq = useRef(0);

  const load = useCallback(
    async (viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        // Report + recent list are independent — fetch both, fail together.
        const [month, recentPage] = await Promise.all([
          monthlyReport(token, currentYm()),
          listExpenses(token, { limit: RECENT_LIMIT }),
        ]);
        if (seq.current !== mine) return;
        setReport(month);
        setRecent(recentPage.items);
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

  // Reload on every focus so a freshly added expense shows up on return.
  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // Sorted high→low for the by-group breakdown; labels fall back to the raw
  // API group name for anything GROUP_LABELS does not know about.
  const groupRows =
    report === null
      ? []
      : Object.entries(report.by_group).sort(([, a], [, b]) =>
          b.localeCompare(a),
        );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.brand}>{BRAND_NAME}</Text>
          <Text style={styles.title}>{STRINGS.bn.dashboardTitle}</Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.settingsButton,
            pressed && styles.settingsButtonPressed,
          ]}
          onPress={() => router.push("/settings")}
          accessibilityRole="button"
          accessibilityLabel={STRINGS.bn.settings}
        >
          <Text style={styles.settingsIcon}>⚙️</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
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
              onPress={() => void load(false)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.retry}
            >
              <Text style={styles.retryLabel}>{STRINGS.bn.retry}</Text>
            </Pressable>
          </View>
        ) : loading ? (
          <Text style={styles.centerNote}>{STRINGS.bn.loadingList}</Text>
        ) : (
          <>
            <View style={styles.totalCard}>
              <Text style={styles.cardLabel}>{STRINGS.bn.monthTotal}</Text>
              <Text style={styles.totalAmt}>
                {formatTaka(report?.total ?? "0.00", "bn")}
              </Text>
              <Text style={styles.cardMeta}>
                {report?.ym} · {report?.count ?? 0} {STRINGS.bn.monthCount}
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>{STRINGS.bn.byGroup}</Text>
              {groupRows.length === 0 ? (
                <Text style={styles.emptyNote}>
                  {STRINGS.bn.noExpensesThisMonth}
                </Text>
              ) : (
                groupRows.map(([grp, amt]) => (
                  <View style={styles.groupRow} key={grp}>
                    <Text style={styles.groupLabel} numberOfLines={1}>
                      {grp in GROUP_LABELS
                        ? GROUP_LABELS[grp as keyof typeof GROUP_LABELS]
                        : grp}
                    </Text>
                    <Text style={styles.groupAmt}>
                      {formatTaka(amt, "bn")}
                    </Text>
                  </View>
                ))
              )}
            </View>

            <View style={styles.card}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>
                  {STRINGS.bn.recentExpenses}
                </Text>
                <Pressable
                  style={({ pressed }) => [
                    styles.seeAllButton,
                    pressed && styles.seeAllButtonPressed,
                  ]}
                  onPress={() => router.push("/list")}
                  accessibilityRole="button"
                  accessibilityLabel={STRINGS.bn.openAllExpenses}
                >
                  <Text style={styles.seeAllLabel} numberOfLines={1}>
                    {STRINGS.bn.openAllExpenses} ›
                  </Text>
                </Pressable>
              </View>
              {recent.length === 0 ? (
                <Text style={styles.emptyNote}>{STRINGS.bn.emptyList}</Text>
              ) : (
                recent.map((expense) => (
                  <View style={styles.recentRow} key={expense.id}>
                    <View style={styles.recentMain}>
                      <Text style={styles.recentCat} numberOfLines={1}>
                        {expense.cat}
                      </Text>
                      <Text style={styles.recentMeta}>{expense.iso}</Text>
                    </View>
                    <Text style={styles.recentAmt}>
                      {formatTaka(expense.amt, "bn")}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.debtsButton,
            pressed && styles.debtsButtonPressed,
          ]}
          onPress={() => router.push("/report")}
          accessibilityRole="button"
          accessibilityLabel={t("bn", "navReport")}
        >
          <Text style={styles.debtsButtonLabel}>{t("bn", "navReport")} →</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.debtsButton,
            pressed && styles.debtsButtonPressed,
          ]}
          onPress={() => router.push("/debts")}
          accessibilityRole="button"
          accessibilityLabel={STRINGS.bn.openDebts}
        >
          <Text style={styles.debtsButtonLabel}>
            {STRINGS.bn.openDebts} →
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.debtsButton,
            pressed && styles.debtsButtonPressed,
          ]}
          onPress={() => router.push("/budget")}
          accessibilityRole="button"
          accessibilityLabel={STRINGS.bn.budgetTitle}
        >
          <Text style={styles.debtsButtonLabel}>
            {STRINGS.bn.budgetTitle} →
          </Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.backButtonPressed,
          ]}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t("bn", "navExpenses")}
        >
          <Text style={styles.backLabel}>← {t("bn", "navExpenses")}</Text>
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.lg,
    paddingHorizontal: theme.spacing.lg,
  },
  headerText: {
    alignItems: "center",
    gap: theme.spacing.xs,
    flex: 1,
  },
  settingsButton: {
    backgroundColor: theme.colors.emeraldSoft,
    borderRadius: theme.radius.control,
    padding: theme.spacing.sm,
  },
  settingsButtonPressed: {
    opacity: 0.7,
  },
  settingsIcon: {
    fontSize: 16,
    color: theme.colors.onAccent,
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
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
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "700",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.md,
  },
  seeAllButton: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  seeAllButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  seeAllLabel: {
    color: theme.colors.emerald,
    fontSize: 13,
    fontWeight: "700",
    flexShrink: 1,
  },
  groupRow: {
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
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  recentMain: {
    flex: 1,
    gap: 2,
  },
  recentCat: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
  },
  recentMeta: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  recentAmt: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "700",
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
  debtsButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  debtsButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  debtsButtonLabel: {
    color: theme.colors.ink,
    fontSize: 15,
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
