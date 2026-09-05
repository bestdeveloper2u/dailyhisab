/**
 * খরচ তালিকা (T12.2) — mobile parity of the frozen prototype's screen-list
 * (www/index.html lines 697–718): debounced search (API ?q=), month chips
 * derived from the loaded data, CSV export (FileSystem.downloadAsync +
 * Sharing.shareAsync), a count+sum day-head, day-grouped rows and cursor
 * pagination via the shared "আরও দেখুন" affordance.
 */
import { BRAND_NAME, formatTaka, toBnDigits } from "@khoroch/core";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { exportExpensesCsvUrl, listExpenses, type Expense } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { MONTH_LABELS, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 350;

/** "all" or a "YYYY-MM" key derived from the loaded entries. */
type MonthFilter = "all" | string;

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

/** "2026-09-05" → "০৫ সেপ্ট ২০২৬"; junk input degrades to bn digits. */
function bnDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return toBnDigits(iso);
  const [, year, mm, dd] = match;
  const month = MONTH_LABELS.bn[Number(mm) - 1] ?? mm;
  return toBnDigits(`${dd} ${month} ${year}`);
}

/** Distinct "YYYY-MM" keys in the loaded rows, newest first. */
function monthKeysOf(items: Expense[]): string[] {
  return Array.from(new Set(items.map((e) => e.iso.slice(0, 7)))).sort().reverse();
}

export default function ExpenseList() {
  const auth = useAuth();

  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [month, setMonth] = useState<MonthFilter>("all");

  const [items, setItems] = useState<Expense[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  // Guard against out-of-order responses (debounced search racing focus/pull).
  const seq = useRef(0);

  // Debounce the search box before it drives the API ?q= param (prototype
  // filters as-you-type; on mobile the 350ms gap keeps request volume sane).
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const loadFirstPage = useCallback(
    async (viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setInitialLoading(true);
      setError(null);
      try {
        const page = await listExpenses(token, {
          limit: PAGE_SIZE,
          q: q.length > 0 ? q : undefined,
        });
        if (seq.current !== mine) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      } catch (err) {
        if (seq.current === mine) setError(describeApiError(err));
      } finally {
        if (seq.current === mine) {
          setInitialLoading(false);
          setRefreshing(false);
        }
      }
    },
    [auth.accessToken, q],
  );

  const loadMore = useCallback(async () => {
    const token = auth.accessToken;
    if (!token || nextCursor === null || loadingMore) return;
    const mine = ++seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listExpenses(token, {
        limit: PAGE_SIZE,
        cursor: nextCursor,
        q: q.length > 0 ? q : undefined,
      });
      if (seq.current !== mine) return;
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (seq.current === mine) setMoreError(describeApiError(err));
    } finally {
      if (seq.current === mine) setLoadingMore(false);
    }
  }, [auth.accessToken, nextCursor, loadingMore, q]);

  // Reload on focus AND whenever the debounced query changes.
  useFocusEffect(
    useCallback(() => {
      void loadFirstPage(false);
    }, [loadFirstPage]),
  );

  /**
   * CSV export (prototype csvBtn): native download with the Bearer header,
   * then the OS share sheet. Any failure degrades to an inline bn hint —
   * the screen must never crash on export.
   */
  const handleExportCsv = useCallback(async () => {
    const token = auth.accessToken;
    if (!token || exporting) return;
    setExporting(true);
    setExportNote(null);
    try {
      const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
      if (dir === null) throw new Error("no-cache-directory");
      // Reuse the same path so repeated exports overwrite instead of piling up.
      const dest = `${dir}daily-hisab-expenses.csv`;
      const { uri } = await FileSystem.downloadAsync(
        exportExpensesCsvUrl(),
        dest,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const available = await Sharing.isAvailableAsync();
      if (!available) throw new Error("sharing-unavailable");
      await Sharing.shareAsync(uri, {
        mimeType: "text/csv",
        dialogTitle: STRINGS.bn.listTitle,
        UTI: "public.comma-separated-values-text",
      });
      setExportNote(STRINGS.bn.csvDone);
    } catch {
      setExportNote(STRINGS.bn.csvShareFailed);
    } finally {
      setExporting(false);
    }
  }, [auth.accessToken, exporting]);

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // Month chips come from the data actually loaded (first page + any pages
  // pulled via "আরও দেখুন"), matching the prototype's client-side filter.
  const months = monthKeysOf(items);
  const multiYear = new Set(months.map((ym) => ym.slice(0, 4))).size > 1;

  const visible =
    month === "all" ? items : items.filter((e) => e.iso.slice(0, 7) === month);
  const sections = groupByDay(visible);

  // Day-head: filtered count + sum (prototype listCountLbl/listSumLbl).
  const sum = visible.reduce((acc, e) => acc + Number(e.amt), 0);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.brand}>{BRAND_NAME}</Text>
        <Text style={styles.title}>{STRINGS.bn.listTitle}</Text>
        <Text style={styles.subtitle}>{STRINGS.bn.listSub}</Text>
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={error === null ? sections : []}
        keyExtractor={(section) => section.iso}
        renderItem={({ item }) => (
          <View style={styles.daySection}>
            <Text style={styles.dayLabel}>{bnDateLabel(item.iso)}</Text>
            {item.entries.map((expense) => (
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
                <Text style={styles.rowAmt}>{formatTaka(expense.amt, "bn")}</Text>
              </View>
            ))}
          </View>
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadFirstPage(true)}
            tintColor={theme.colors.emerald}
          />
        }
        ListHeaderComponent={
          <View style={styles.toolbar}>
            <TextInput
              style={styles.search}
              placeholder={STRINGS.bn.searchPlaceholder}
              placeholderTextColor={theme.colors.muted}
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel={STRINGS.bn.searchPlaceholder}
            />
            <View style={styles.chipRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipScroll}
              >
                <Chip
                  label={STRINGS.bn.allMonths}
                  selected={month === "all"}
                  onPress={() => setMonth("all")}
                />
                {months.map((ym) => (
                  <Chip
                    key={ym}
                    label={chipLabel(ym, multiYear)}
                    selected={month === ym}
                    onPress={() => setMonth(ym)}
                  />
                ))}
              </ScrollView>
              <Pressable
                style={({ pressed }) => [
                  styles.exportButton,
                  pressed && styles.exportButtonPressed,
                  exporting && styles.exportButtonDisabled,
                ]}
                onPress={() => void handleExportCsv()}
                disabled={exporting}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.exportCsv}
              >
                <Text style={styles.exportLabel}>
                  {exporting ? "…" : STRINGS.bn.exportCsv}
                </Text>
              </Pressable>
            </View>
            {exportNote !== null && (
              <Text style={styles.exportNote} numberOfLines={2}>
                {exportNote}
              </Text>
            )}
            {error === null && !initialLoading && (
              <View style={styles.dayHead}>
                <Text style={styles.dayHeadCount} numberOfLines={1}>
                  {toBnDigits(String(visible.length))} {STRINGS.bn.entriesShort}
                </Text>
                <Text style={styles.dayHeadSum}>{formatTaka(sum, "bn")}</Text>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          initialLoading ? (
            <Text style={styles.centerNote}>{STRINGS.bn.loadingList}</Text>
          ) : error !== null ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.retryButtonPressed,
                ]}
                onPress={() => void loadFirstPage(false)}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.retry}
              >
                <Text style={styles.retryLabel}>{STRINGS.bn.retry}</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.centerNote}>
              {q.length > 0 || month !== "all"
                ? STRINGS.bn.emptySearch
                : STRINGS.bn.emptyList}
            </Text>
          )
        }
        ListFooterComponent={
          <>
            {moreError !== null && (
              <Text style={[styles.centerNote, styles.errorText]}>{moreError}</Text>
            )}
            {nextCursor !== null && visible.length > 0 && (
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
                <Text style={styles.moreButtonLabel}>
                  {loadingMore ? STRINGS.bn.loadingMore : STRINGS.bn.loadMore}
                </Text>
              </Pressable>
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
              <Text style={styles.backLabel}>← {STRINGS.bn.openDashboard}</Text>
            </Pressable>
          </>
        }
      />
    </View>
  );
}

/** "2026-09" → "সেপ্ট"; the year is appended (bn digits) when data spans years. */
function chipLabel(ym: string, withYear: boolean): string {
  const idx = Number(ym.slice(5, 7)) - 1;
  const label = MONTH_LABELS.bn[idx] ?? ym;
  return withYear ? `${label} ${toBnDigits(ym.slice(0, 4))}` : label;
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
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]} numberOfLines={1}>
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
  list: {
    flex: 1,
  },
  listContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  toolbar: {
    gap: theme.spacing.md,
  },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface,
    color: theme.colors.ink,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm + 2,
    fontSize: 15,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  chipScroll: {
    alignItems: "center",
    gap: theme.spacing.sm,
    flexGrow: 1,
  },
  chip: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
    backgroundColor: theme.colors.surface,
  },
  chipSelected: {
    backgroundColor: theme.colors.emerald,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipLabel: {
    color: theme.colors.ink,
    fontSize: 13,
    fontWeight: "600",
  },
  chipLabelSelected: {
    color: theme.colors.onAccent,
  },
  exportButton: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs + 2,
  },
  exportButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  exportButtonDisabled: {
    opacity: 0.5,
  },
  exportLabel: {
    color: theme.colors.ink,
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  exportNote: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  dayHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing.md,
    marginTop: theme.spacing.xs,
  },
  dayHeadCount: {
    color: theme.colors.ink,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  dayHeadSum: {
    color: theme.colors.muted,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  daySection: {
    gap: theme.spacing.sm,
  },
  dayLabel: {
    color: theme.colors.muted,
    fontSize: 12,
    fontWeight: "600",
  },
  row: {
    backgroundColor: theme.colors.surface,
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
  centerNote: {
    color: theme.colors.muted,
    fontSize: 14,
    textAlign: "center",
    paddingVertical: theme.spacing.lg,
  },
  errorBox: {
    alignItems: "center",
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.lg,
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
  moreButton: {
    alignSelf: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  moreButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  moreButtonDisabled: {
    opacity: 0.5,
  },
  moreButtonLabel: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
  },
  backButton: {
    alignSelf: "center",
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    marginTop: theme.spacing.sm,
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
