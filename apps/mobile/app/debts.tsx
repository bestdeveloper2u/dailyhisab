import { moneyFromNumber, t } from "@khoroch/core";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  createDebt,
  listDebts,
  payDebt,
  type Debt,
  type DebtDir,
  type DebtStatusFilter,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const PAGE_SIZE = 20;

/** ^\d+([.]\\d{1,2})?$ — mirrors the API's numeric(12,2) domain. */
const AMOUNT_RE = /^\d+([.]\d{1,2})?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidIso(value: string): boolean {
  if (!ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const STATUS_FILTERS: {
  key: DebtStatusFilter;
  label: string;
}[] = [
  { key: "open", label: STRINGS.bn.statusOpen },
  { key: "settled", label: STRINGS.bn.statusSettled },
  { key: "all", label: STRINGS.bn.statusAll },
];

const DIRS: { key: DebtDir; label: string }[] = [
  { key: "lend", label: STRINGS.bn.dirLend },
  { key: "borrow", label: STRINGS.bn.dirBorrow },
];

/**
 * Debts (T3.4): list / add / pay against /api/v1/debts.
 * List honors ?status=open|settled|all with keyset "load more"; pay posts to
 * /debts/{id}/pay and surfaces FULL vs PARTIAL inline.
 */
export default function Debts() {
  const auth = useAuth();

  const [status, setStatus] = useState<DebtStatusFilter>("open");
  const [items, setItems] = useState<Debt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);

  // Add form.
  const [showAdd, setShowAdd] = useState(false);
  const [party, setParty] = useState("");
  const [dir, setDir] = useState<DebtDir>("lend");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [iso, setIso] = useState(todayIso());
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Pay flow: which row's pay input is open + its state.
  const [payId, setPayId] = useState<string | null>(null);
  const [payAmt, setPayAmt] = useState("");
  const [payPending, setPayPending] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payResult, setPayResult] = useState<string | null>(null);

  // Guard against out-of-order list responses.
  const seq = useRef(0);

  const loadFirstPage = useCallback(
    async (filter: DebtStatusFilter, viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setInitialLoading(true);
      setError(null);
      try {
        const page = await listDebts(token, {
          status: filter,
          limit: PAGE_SIZE,
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
    [auth.accessToken],
  );

  const loadMore = useCallback(async () => {
    const token = auth.accessToken;
    if (!token || nextCursor === null || loadingMore) return;
    const mine = ++seq.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listDebts(token, {
        status,
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
  }, [auth.accessToken, nextCursor, loadingMore, status]);

  // Reload on every focus so adds/pays made here or elsewhere show up.
  useFocusEffect(
    useCallback(() => {
      void loadFirstPage(status, false);
    }, [loadFirstPage, status]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  const normalizedAmount = amount.trim().replace(/^৳\s*/, "");
  const normalizedPay = payAmt.trim().replace(/^৳\s*/, "");
  const validParty = party.trim().length > 0 && party.trim().length <= 120;
  const validAmount =
    AMOUNT_RE.test(normalizedAmount) && Number(normalizedAmount) > 0;
  const validIso = isValidIso(iso.trim());
  const validNote = note.trim().length <= 200;
  const canSubmit = validParty && validAmount && validIso && validNote && !pending;
  const canPay = AMOUNT_RE.test(normalizedPay) && Number(normalizedPay) > 0 && !payPending;

  async function handleCreate() {
    const token = auth.accessToken;
    if (!canSubmit || !token) return;
    setPending(true);
    setFormError(null);
    try {
      const trimmedNote = note.trim();
      await createDebt(token, {
        party: party.trim(),
        dir,
        amt: moneyFromNumber(Number(normalizedAmount)), // "2000" → "2000.00"
        note: trimmedNote.length > 0 ? trimmedNote : null,
        iso: iso.trim(),
      });
      setParty("");
      setAmount("");
      setNote("");
      setIso(todayIso());
      setShowAdd(false);
      setPayResult(null);
      await loadFirstPage(status, false);
    } catch (err) {
      setFormError(describeApiError(err));
    } finally {
      setPending(false);
    }
  }

  async function handlePay(debt: Debt) {
    const token = auth.accessToken;
    if (!canPay || !token || payId !== debt.id) return;
    setPayPending(true);
    setPayError(null);
    try {
      const result = await payDebt(
        token,
        debt.id,
        moneyFromNumber(Number(normalizedPay)),
      );
      setPayResult(
        result.status === "FULL"
          ? `${STRINGS.bn.payFull} · ${debt.party}`
          : `${STRINGS.bn.payPartial} ${formatRemaining(result.debt.amt)}`,
      );
      setPayId(null);
      setPayAmt("");
      // FULL removes the row from ?status=open; just refetch the current view.
      await loadFirstPage(status, false);
    } catch (err) {
      setPayError(describeApiError(err));
    } finally {
      setPayPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.brand}>{t("bn", "appName")}</Text>
        <Text style={styles.title}>{STRINGS.bn.debtsTitle}</Text>
        <View style={styles.chipRow}>
          {STATUS_FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              selected={status === f.key}
              disabled={false}
              onPress={() => setStatus(f.key)}
            />
          ))}
        </View>
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={error === null ? items : []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <DebtRow
            debt={item}
            payOpen={payId === item.id}
            payAmt={payId === item.id ? payAmt : ""}
            payPending={payPending}
            payError={payId === item.id ? payError : null}
            canPay={canPay}
            onPayPress={() => {
              setPayId(payId === item.id ? null : item.id);
              setPayAmt("");
              setPayError(null);
            }}
            onPayChange={setPayAmt}
            onPayConfirm={() => void handlePay(item)}
            onPayCancel={() => {
              setPayId(null);
              setPayAmt("");
              setPayError(null);
            }}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadFirstPage(status, true)}
            tintColor={theme.colors.emerald}
          />
        }
        ListHeaderComponent={
          <View style={styles.topArea}>
            {payResult !== null && (
              <Text style={styles.payResultNote}>{payResult}</Text>
            )}
            <Pressable
              style={({ pressed }) => [
                styles.addButton,
                pressed && styles.addButtonPressed,
              ]}
              onPress={() => setShowAdd((prev) => !prev)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.addDebt}
            >
              <Text style={styles.addButtonLabel}>
                {showAdd ? "×" : "＋"} {STRINGS.bn.addDebt}
              </Text>
            </Pressable>

            {showAdd && (
              <View style={styles.form}>
                <Text style={styles.label}>{STRINGS.bn.party}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={STRINGS.bn.partyPlaceholder}
                  placeholderTextColor={theme.colors.muted}
                  value={party}
                  onChangeText={setParty}
                  editable={!pending}
                  maxLength={120}
                />

                <Text style={styles.label}>{STRINGS.bn.dirLabel}</Text>
                <View style={styles.chipRow}>
                  {DIRS.map((d) => (
                    <Chip
                      key={d.key}
                      label={d.label}
                      selected={dir === d.key}
                      disabled={pending}
                      onPress={() => setDir(d.key)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>{STRINGS.bn.amount}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={STRINGS.bn.amountPlaceholder}
                  placeholderTextColor={theme.colors.muted}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  editable={!pending}
                />

                <Text style={styles.label}>{STRINGS.bn.dateLabel}</Text>
                <TextInput
                  style={styles.input}
                  value={iso}
                  onChangeText={setIso}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  editable={!pending}
                />

                <Text style={styles.label}>{STRINGS.bn.noteLabel}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={STRINGS.bn.notePlaceholder}
                  placeholderTextColor={theme.colors.muted}
                  value={note}
                  onChangeText={setNote}
                  editable={!pending}
                  maxLength={200}
                />

                <Pressable
                  style={({ pressed }) => [
                    styles.submitButton,
                    (!canSubmit || pressed) && styles.submitButtonDisabled,
                  ]}
                  onPress={() => void handleCreate()}
                  disabled={!canSubmit}
                  accessibilityRole="button"
                  accessibilityLabel={STRINGS.bn.save}
                >
                  <Text style={styles.submitLabel}>
                    {pending ? STRINGS.bn.saving : STRINGS.bn.save}
                  </Text>
                </Pressable>
                {!validParty && party.length > 0 && (
                  <Text style={styles.hintError}>{STRINGS.bn.errParty}</Text>
                )}
                {!validAmount && amount.length > 0 && (
                  <Text style={styles.hintError}>
                    {STRINGS.bn.errDebtAmount}
                  </Text>
                )}
                {!validIso && (
                  <Text style={styles.hintError}>{STRINGS.bn.errDate}</Text>
                )}
                {formError !== null && (
                  <Text style={styles.hintError}>{formError}</Text>
                )}
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          initialLoading ? (
            <Text style={styles.centerNote}>{STRINGS.bn.loadingDebts}</Text>
          ) : error !== null ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.retryButtonPressed,
                ]}
                onPress={() => void loadFirstPage(status, false)}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.retry}
              >
                <Text style={styles.retryLabel}>{STRINGS.bn.retry}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.emptyTitle}>{STRINGS.bn.emptyDebts}</Text>
              <Text style={styles.emptyHint}>{STRINGS.bn.emptyDebtsHint}</Text>
            </View>
          )
        }
        ListFooterComponent={
          <>
            {moreError !== null && (
              <Text style={[styles.centerNote, styles.errorText]}>
                {moreError}
              </Text>
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
          </>
        }
      />
    </KeyboardAvoidingView>
  );
}

/** "1234.50" → "১২৩৪.৫০ ৳"-style display helper for the PARTIAL banner. */
function formatRemaining(amt: string): string {
  return `৳${amt}`;
}

function Chip({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !disabled && styles.chipPressed,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function DebtRow({
  debt,
  payOpen,
  payAmt,
  payPending,
  payError,
  canPay,
  onPayPress,
  onPayChange,
  onPayConfirm,
  onPayCancel,
}: {
  debt: Debt;
  payOpen: boolean;
  payAmt: string;
  payPending: boolean;
  payError: string | null;
  canPay: boolean;
  onPayPress: () => void;
  onPayChange: (value: string) => void;
  onPayConfirm: () => void;
  onPayCancel: () => void;
}) {
  const settled = debt.settled_at !== null;
  const settledOn =
    debt.settled_at !== null ? debt.settled_at.slice(0, 10) : null;
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.rowParty} numberOfLines={1}>
            {debt.party}
          </Text>
          <View
            style={[
              styles.dirBadge,
              debt.dir === "lend"
                ? styles.dirBadgeLend
                : styles.dirBadgeBorrow,
            ]}
          >
            <Text style={styles.dirBadgeLabel}>
              {debt.dir === "lend"
                ? STRINGS.bn.dirLend
                : STRINGS.bn.dirBorrow}
            </Text>
          </View>
        </View>
        {debt.note !== null && debt.note !== "" && (
          <Text style={styles.rowNote} numberOfLines={1}>
            {debt.note}
          </Text>
        )}
        <Text style={styles.rowMeta}>
          {debt.iso}
          {settledOn !== null ? ` · ${STRINGS.bn.settledOn} ${settledOn}` : ""}
        </Text>

        {payOpen && !settled && (
          <View style={styles.payBox}>
            <Text style={styles.payLabel}>{STRINGS.bn.payTitle}</Text>
            <TextInput
              style={styles.input}
              placeholder={STRINGS.bn.payPlaceholder}
              placeholderTextColor={theme.colors.muted}
              value={payAmt}
              onChangeText={onPayChange}
              keyboardType="decimal-pad"
              editable={!payPending}
              autoFocus
            />
            <View style={styles.payActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.payConfirm,
                  (!canPay || pressed) && styles.payConfirmDisabled,
                ]}
                onPress={onPayConfirm}
                disabled={!canPay}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.confirmPay}
              >
                <Text style={styles.payConfirmLabel}>
                  {payPending ? STRINGS.bn.paying : STRINGS.bn.confirmPay}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.payCancel,
                  pressed && styles.payCancelPressed,
                ]}
                onPress={onPayCancel}
                disabled={payPending}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.cancel}
              >
                <Text style={styles.payCancelLabel}>{STRINGS.bn.cancel}</Text>
              </Pressable>
            </View>
            {payError !== null && (
              <Text style={styles.hintError}>{payError}</Text>
            )}
          </View>
        )}
      </View>

      <View style={styles.rowSide}>
        <Text style={styles.rowAmt}>৳{debt.amt}</Text>
        {!settled && !payOpen && (
          <Pressable
            style={({ pressed }) => [
              styles.payButton,
              pressed && styles.payButtonPressed,
            ]}
            onPress={onPayPress}
            accessibilityRole="button"
            accessibilityLabel={`${STRINGS.bn.pay} ${debt.party}`}
          >
            <Text style={styles.payButtonLabel}>{STRINGS.bn.pay}</Text>
          </Pressable>
        )}
      </View>
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
  brand: {
    color: theme.colors.onAccent,
    fontSize: 16,
    fontWeight: "700",
  },
  title: {
    color: theme.colors.onAccent,
    fontSize: 22,
    fontWeight: "700",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
    justifyContent: "center",
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  topArea: {
    gap: theme.spacing.md,
  },
  payResultNote: {
    color: theme.colors.emerald,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
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
  form: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  label: {
    color: theme.colors.muted,
    fontSize: 13,
    marginTop: theme.spacing.xs,
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
  chip: {
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  chipSelected: {
    backgroundColor: theme.colors.emerald,
    borderColor: theme.colors.emerald,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipLabel: {
    color: theme.colors.ink,
    fontSize: 13,
  },
  chipLabelSelected: {
    color: theme.colors.onAccent,
    fontWeight: "600",
  },
  submitButton: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: theme.colors.onAccent,
    fontSize: 16,
    fontWeight: "600",
  },
  hintError: {
    color: theme.colors.danger,
    fontSize: 13,
    textAlign: "center",
  },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    flexDirection: "row",
    gap: theme.spacing.md,
  },
  rowMain: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  rowParty: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "600",
    flexShrink: 1,
  },
  dirBadge: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  dirBadgeLend: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  dirBadgeBorrow: {
    backgroundColor: theme.colors.dangerSoft,
  },
  dirBadgeLabel: {
    color: theme.colors.ink,
    fontSize: 11,
    fontWeight: "600",
  },
  rowNote: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  rowMeta: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  rowSide: {
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  rowAmt: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "700",
  },
  payButton: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  payButtonPressed: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  payButtonLabel: {
    color: theme.colors.onAccent,
    fontSize: 12,
    fontWeight: "600",
  },
  payBox: {
    marginTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  payLabel: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  payActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  payConfirm: {
    backgroundColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  payConfirmDisabled: {
    opacity: 0.5,
  },
  payConfirmLabel: {
    color: theme.colors.onAccent,
    fontSize: 14,
    fontWeight: "600",
  },
  payCancel: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface2,
  },
  payCancelPressed: {
    opacity: 0.8,
  },
  payCancelLabel: {
    color: theme.colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.xs,
  },
  emptyTitle: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyHint: {
    color: theme.colors.muted,
    fontSize: 13,
    textAlign: "center",
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
