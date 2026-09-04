import { BRAND_NAME, formatTaka, t } from "@khoroch/core";
import { Redirect, useRouter, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { listExpenses, type Expense } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { GROUP_LABELS, PAY_LABELS, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const PAGE_SIZE = 20;

/** Signed-in dashboard: the caller's real expense list (GET /api/v1/expenses). */
export default function Index() {
  const auth = useAuth();
  const router = useRouter();

  const [items, setItems] = useState<Expense[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Guard against out-of-order list responses (pull-to-refresh racing focus).
  const seq = useRef(0);

  const loadFirstPage = useCallback(
    async (viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setInitialLoading(true);
      setError(null);
      try {
        const page = await listExpenses(token, { limit: PAGE_SIZE });
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
    [auth.accessToken],
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
      });
      if (seq.current !== mine) return;
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (seq.current === mine) setMoreError(describeApiError(err));
    } finally {
      if (seq.current === mine) setLoadingMore(false);
    }
  }, [auth.accessToken, nextCursor, loadingMore]);

  // Reload on every focus so a freshly added expense shows up on return.
  useFocusEffect(
    useCallback(() => {
      void loadFirstPage(false);
    }, [loadFirstPage]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
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

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={error === null ? items : []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ExpenseRow expense={item} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadFirstPage(true)}
            tintColor={theme.colors.emerald}
          />
        }
        ListHeaderComponent={
          <View style={styles.topCards}>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>{STRINGS.bn.account}</Text>
              <Text style={styles.userEmail} numberOfLines={1}>
                {auth.user.email}
              </Text>
              <Text style={styles.countNote}>
                {items.length} {STRINGS.bn.entriesLoaded}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [
                styles.addButton,
                pressed && styles.addButtonPressed,
              ]}
              onPress={() => router.push("/add")}
              accessibilityRole="button"
              accessibilityLabel={t("bn", "addExpense")}
            >
              <Text style={styles.addButtonLabel}>＋ {t("bn", "addExpense")}</Text>
            </Pressable>
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
            <View style={styles.card}>
              <Text style={styles.emptyListTitle}>{STRINGS.bn.emptyList}</Text>
              <Text style={styles.emptyListHint}>{STRINGS.bn.emptyListHint}</Text>
            </View>
          )
        }
        ListFooterComponent={
          <>
            {moreError !== null && (
              <Text style={[styles.centerNote, styles.errorText]}>{moreError}</Text>
            )}
            {nextCursor !== null && items.length > 0 && (
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
          </>
        }
      />

      <Pressable
        style={({ pressed }) => [
          styles.logoutButton,
          pressed && styles.logoutButtonPressed,
        ]}
        onPress={() => void auth.logout()}
        accessibilityRole="button"
        accessibilityLabel={t("bn", "logout")}
      >
        <Text style={styles.logoutLabel}>{t("bn", "logout")}</Text>
      </Pressable>
    </View>
  );
}

function ExpenseRow({ expense }: { expense: Expense }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowCat} numberOfLines={1}>
          {expense.cat}
        </Text>
        {expense.desc !== null && expense.desc !== "" && (
          <Text style={styles.rowDesc} numberOfLines={1}>
            {expense.desc}
          </Text>
        )}
        <Text style={styles.rowMeta}>
          {GROUP_LABELS[expense.grp]} · {PAY_LABELS[expense.pay]} · {expense.iso}
        </Text>
      </View>
      <Text style={styles.rowAmt}>{formatTaka(expense.amt, "bn")}</Text>
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
    gap: theme.spacing.sm,
  },
  logoBox: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.logo,
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
  list: {
    flex: 1,
  },
  listContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  topCards: {
    gap: theme.spacing.md,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.xs,
  },
  cardLabel: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  userEmail: {
    color: theme.colors.ink,
    fontSize: 18,
    fontWeight: "600",
  },
  countNote: {
    color: theme.colors.muted,
    fontSize: 12,
    marginTop: theme.spacing.xs,
  },
  addButton: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  addButtonPressed: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  addButtonLabel: {
    color: theme.colors.onAccent,
    fontSize: 16,
    fontWeight: "600",
  },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
  },
  rowMain: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  rowCat: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "600",
  },
  rowDesc: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  rowMeta: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  rowAmt: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "700",
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
  emptyListTitle: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyListHint: {
    color: theme.colors.muted,
    fontSize: 13,
    textAlign: "center",
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
  logoutButton: {
    alignSelf: "center",
    margin: theme.spacing.lg,
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  logoutButtonPressed: {
    backgroundColor: theme.colors.danger,
  },
  logoutLabel: {
    color: theme.colors.danger,
    fontSize: 14,
    fontWeight: "600",
  },
});
