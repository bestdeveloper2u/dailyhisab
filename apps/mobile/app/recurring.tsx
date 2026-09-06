import { formatTaka, moneyFromNumber, toBnDigits } from "@khoroch/core";
import { Redirect, router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  createRecurring,
  deleteRecurring,
  listRecurring,
  runRecurring,
  updateRecurring,
  type ExpenseGroup,
  type PayMethod,
  type Recurring,
  type RecurringFreq,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { usePrefs } from "../lib/prefs";
import { GROUP_LABELS, MONTH_NAMES, PAY_LABELS, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";
import { useToast } from "../lib/toast";

/** ^\d+([.]\\d{1,2})?$ — mirrors the API's numeric(12,2) domain. */
const AMOUNT_RE = /^\d+([.]\d{1,2})?$/;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const GROUPS = Object.keys(GROUP_LABELS) as ExpenseGroup[];
const PAY_METHODS = Object.keys(PAY_LABELS) as PayMethod[];

const FREQS: { key: RecurringFreq; label: string }[] = [
  { key: "daily", label: STRINGS.bn.freqDaily },
  { key: "weekly", label: STRINGS.bn.freqWeekly },
  { key: "monthly", label: STRINGS.bn.freqMonthly },
  { key: "yearly", label: STRINGS.bn.freqYearly },
];

/** freq → row label: প্রতি দিন / প্রতি সপ্তাহে / প্রতি মাসে / প্রতি বছরে. */
const EVERY_LABELS: Record<RecurringFreq, string> = {
  daily: STRINGS.bn.everyDaily,
  weekly: STRINGS.bn.everyWeekly,
  monthly: STRINGS.bn.everyMonthly,
  yearly: STRINGS.bn.everyYearly,
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidIso(value: string): boolean {
  if (!ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "2026-09-07" → "৭ সেপ্টেম্বর" — bn next-run label (T16.3). */
function bnDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return toBnDigits(iso);
  const name = MONTH_NAMES.bn[Number(match[2]) - 1] ?? "";
  return `${toBnDigits(String(Number(match[3])))} ${name}`;
}

/**
 * Recurring expenses (T16.3) on the ACCEPTED T16.1 contract: rules are
 * cat/grp/amt/pay/desc + freq (daily|weekly|monthly|yearly) + start_date —
 * no title/weekday/monthday. Keyset list (next_cursor load-more); the active
 * toggle PATCHes {active} with revert-on-error; "এখন চালান" POSTs
 * /recurring/run (a WRITE that materializes catch-up expenses) and surfaces
 * the created count via toast.
 */
export default function RecurringScreen() {
  const auth = useAuth();
  const { t, lang } = usePrefs();
  const toast = useToast();

  const [items, setItems] = useState<Recurring[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Add form.
  const [showAdd, setShowAdd] = useState(false);
  const [cat, setCat] = useState("");
  const [grp, setGrp] = useState<ExpenseGroup>("food");
  const [amount, setAmount] = useState("");
  const [pay, setPay] = useState<PayMethod>("cash");
  const [desc, setDesc] = useState("");
  const [freq, setFreq] = useState<RecurringFreq>("monthly");
  const [startDate, setStartDate] = useState(todayIso());
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Row actions.
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [runPending, setRunPending] = useState(false);
  const [runNote, setRunNote] = useState<string | null>(null);

  // Guard against out-of-order list responses.
  const seq = useRef(0);

  const load = useCallback(
    async (viaPull: boolean) => {
      const token = auth.accessToken;
      if (!token) return;
      const mine = ++seq.current;
      if (viaPull) setRefreshing(true);
      else setInitialLoading(true);
      setError(null);
      try {
        const page = await listRecurring(token);
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

  /** Keyset load-more: append the next page via the opaque next_cursor. */
  const loadMore = useCallback(async () => {
    const token = auth.accessToken;
    if (!token || loadingMore || nextCursor === null) return;
    const mine = ++seq.current;
    setLoadingMore(true);
    try {
      const page = await listRecurring(token, { cursor: nextCursor });
      if (seq.current !== mine) return;
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (seq.current === mine) setRowError(describeApiError(err));
    } finally {
      if (seq.current === mine) setLoadingMore(false);
    }
  }, [auth.accessToken, loadingMore, nextCursor]);

  // Reload on every focus so adds made elsewhere show up.
  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  // Same ৳-strip normalization as app/add.tsx.
  const normalizedAmount = amount.trim().replace(/^৳\s*/, "");
  const validCat = cat.trim().length > 0 && cat.trim().length <= 80;
  const validAmount =
    AMOUNT_RE.test(normalizedAmount) && Number(normalizedAmount) > 0;
  const validStartDate = isValidIso(startDate.trim());
  const canSubmit = validCat && validAmount && validStartDate && !pending;

  async function handleCreate() {
    const token = auth.accessToken;
    if (!canSubmit || !token) return;
    setPending(true);
    setFormError(null);
    try {
      const trimmedDesc = desc.trim();
      await createRecurring(token, {
        cat: cat.trim(),
        grp,
        amt: moneyFromNumber(Number(normalizedAmount)), // "49" → "49.00"
        pay,
        desc: trimmedDesc.length > 0 ? trimmedDesc : null,
        freq,
        start_date: startDate.trim(),
      });
      setCat("");
      setAmount("");
      setDesc("");
      setStartDate(todayIso());
      setShowAdd(false);
      toast(t("toastRecurringAdded"));
      await load(false);
    } catch (err) {
      setFormError(describeApiError(err));
    } finally {
      setPending(false);
    }
  }

  /** Active toggle → PATCH {active}; optimistic set, revert on failure. */
  async function handleToggle(item: Recurring, next: boolean) {
    const token = auth.accessToken;
    if (togglingId !== null || !token) return;
    setTogglingId(item.id);
    setRowError(null);
    setItems((prev) =>
      prev.map((row) => (row.id === item.id ? { ...row, active: next } : row)),
    );
    try {
      const updated = await updateRecurring(token, item.id, { active: next });
      setItems((prev) =>
        prev.map((row) => (row.id === updated.id ? updated : row)),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((row) =>
          row.id === item.id ? { ...row, active: item.active } : row,
        ),
      );
      setRowError(describeApiError(err));
    } finally {
      setTogglingId(null);
    }
  }

  async function handleDelete(item: Recurring) {
    const token = auth.accessToken;
    if (deletingId !== null || !token) return;
    setDeletingId(item.id);
    setRowError(null);
    try {
      await deleteRecurring(token, item.id);
      setDeleteConfirmId(null);
      setItems((prev) => prev.filter((row) => row.id !== item.id));
      toast(t("toastRecurringDeleted"));
    } catch (err) {
      setRowError(describeApiError(err));
    } finally {
      setDeletingId(null);
    }
  }

  /** POST /recurring/run — creates catch-up expenses, then reloads. */
  async function handleRunNow() {
    const token = auth.accessToken;
    if (runPending || !token) return;
    setRunPending(true);
    setRowError(null);
    try {
      const result = await runRecurring(token);
      if (result.created > 0) {
        const count =
          lang === "bn"
            ? toBnDigits(String(result.created))
            : String(result.created);
        setRunNote(`${count} ${t("toastRecurringRunSuffix")}`);
        toast(`${count} ${t("toastRecurringRunSuffix")}`);
      } else {
        setRunNote(null);
        toast(t("toastRecurringRunZero"));
      }
      await load(false);
    } catch (err) {
      setRowError(describeApiError(err));
    } finally {
      setRunPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.brand}>{STRINGS.bn.recurringTitle}</Text>
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={error === null ? items : []}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RecurringRow
            item={item}
            toggling={togglingId === item.id}
            confirmDelete={deleteConfirmId === item.id}
            deleting={deletingId === item.id}
            onToggle={(next) => void handleToggle(item, next)}
            onDeletePress={() => {
              setRowError(null);
              setDeleteConfirmId(item.id);
            }}
            onDeleteConfirm={() => void handleDelete(item)}
            onDeleteCancel={() => setDeleteConfirmId(null)}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor={theme.colors.emerald}
          />
        }
        ListHeaderComponent={
          <View style={styles.topArea}>
            {rowError !== null && (
              <Text style={styles.errorText} numberOfLines={2}>
                {rowError}
              </Text>
            )}
            {runNote !== null && (
              <Text style={styles.runNote} numberOfLines={1}>
                {runNote}
              </Text>
            )}

            <Pressable
              style={({ pressed }) => [
                styles.runButton,
                (runPending || pressed) && styles.runButtonPressed,
              ]}
              onPress={() => void handleRunNow()}
              disabled={runPending}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.runNow}
            >
              <Text style={styles.runButtonLabel} numberOfLines={1}>
                {runPending
                  ? STRINGS.bn.running
                  : `▶ ${STRINGS.bn.runNow}`}
              </Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.addButton,
                pressed && styles.addButtonPressed,
              ]}
              onPress={() => setShowAdd((prev) => !prev)}
              accessibilityRole="button"
              accessibilityLabel={STRINGS.bn.addRecurring}
            >
              <Text style={styles.addButtonLabel} numberOfLines={1}>
                {showAdd ? "×" : "＋"} {STRINGS.bn.addRecurring}
              </Text>
            </Pressable>

            {showAdd && (
              <View style={styles.form}>
                <Text style={styles.label}>{STRINGS.bn.category}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={STRINGS.bn.categoryPlaceholder}
                  placeholderTextColor={theme.colors.muted}
                  value={cat}
                  onChangeText={setCat}
                  editable={!pending}
                  maxLength={80}
                />

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

                <Text style={styles.label}>{STRINGS.bn.groupLabel}</Text>
                <View style={styles.chipRow}>
                  {GROUPS.map((g) => (
                    <Chip
                      key={g}
                      label={GROUP_LABELS[g]}
                      selected={grp === g}
                      disabled={pending}
                      onPress={() => setGrp(g)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>{STRINGS.bn.payLabel}</Text>
                <View style={styles.chipRow}>
                  {PAY_METHODS.map((p) => (
                    <Chip
                      key={p}
                      label={PAY_LABELS[p]}
                      selected={pay === p}
                      disabled={pending}
                      onPress={() => setPay(p)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>{STRINGS.bn.descLabel}</Text>
                <TextInput
                  style={styles.input}
                  placeholder={STRINGS.bn.descPlaceholder}
                  placeholderTextColor={theme.colors.muted}
                  value={desc}
                  onChangeText={setDesc}
                  editable={!pending}
                  maxLength={200}
                />

                <Text style={styles.label}>{STRINGS.bn.freqLabel}</Text>
                <View style={styles.chipRow}>
                  {FREQS.map((f) => (
                    <Chip
                      key={f.key}
                      label={f.label}
                      selected={freq === f.key}
                      disabled={pending}
                      onPress={() => setFreq(f.key)}
                    />
                  ))}
                </View>

                <Text style={styles.label}>{STRINGS.bn.startDateLabel}</Text>
                <TextInput
                  style={[styles.input, styles.dateInput]}
                  value={startDate}
                  onChangeText={setStartDate}
                  keyboardType="numbers-and-punctuation"
                  maxLength={10}
                  editable={!pending}
                />
                {!validStartDate && startDate.trim().length > 0 && (
                  <Text style={styles.hintError}>{STRINGS.bn.errDate}</Text>
                )}

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
                {!validCat && cat.length > 0 && (
                  <Text style={styles.hintError}>
                    {STRINGS.bn.errCategory}
                  </Text>
                )}
                {!validAmount && amount.length > 0 && (
                  <Text style={styles.hintError}>
                    {STRINGS.bn.errDebtAmount}
                  </Text>
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
            <Text style={styles.centerNote}>
              {STRINGS.bn.loadingRecurring}
            </Text>
          ) : error !== null ? (
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
          ) : (
            <View style={styles.card}>
              <Text style={styles.emptyTitle} numberOfLines={1}>
                {STRINGS.bn.emptyRecurring}
              </Text>
              <Text style={styles.emptyHint} numberOfLines={2}>
                {STRINGS.bn.emptyRecurringHint}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            {nextCursor !== null && error === null && (
              <Pressable
                style={({ pressed }) => [
                  styles.loadMoreButton,
                  (loadingMore || pressed) && styles.loadMoreButtonPressed,
                ]}
                onPress={() => void loadMore()}
                disabled={loadingMore}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.loadMore}
              >
                <Text style={styles.loadMoreLabel} numberOfLines={1}>
                  {loadingMore
                    ? STRINGS.bn.loadingMore
                    : STRINGS.bn.loadMore}
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
              accessibilityLabel={STRINGS.bn.dashboardTitle}
            >
              <Text style={styles.backLabel}>
                ← {STRINGS.bn.dashboardTitle}
              </Text>
            </Pressable>
          </View>
        }
      />
    </KeyboardAvoidingView>
  );
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
      <Text
        style={[styles.chipLabel, selected && styles.chipLabelSelected]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function RecurringRow({
  item,
  toggling,
  confirmDelete,
  deleting,
  onToggle,
  onDeletePress,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  item: Recurring;
  toggling: boolean;
  confirmDelete: boolean;
  deleting: boolean;
  onToggle: (next: boolean) => void;
  onDeletePress: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.cat}
          </Text>
          <View
            style={[
              styles.activeBadge,
              item.active ? styles.activeBadgeOn : styles.activeBadgeOff,
            ]}
          >
            <Text style={styles.activeBadgeLabel} numberOfLines={1}>
              {item.active ? STRINGS.bn.onLabel : STRINGS.bn.offLabel}
            </Text>
          </View>
        </View>
        {item.desc !== null && item.desc.length > 0 && (
          <Text style={styles.rowDesc} numberOfLines={2}>
            {item.desc}
          </Text>
        )}
        <Text style={styles.rowFreq} numberOfLines={1}>
          {EVERY_LABELS[item.freq]}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {STRINGS.bn.nextRun}: {bnDateLabel(item.next_run)}
        </Text>

        {confirmDelete && (
          <View style={styles.confirmBox}>
            <Text style={styles.confirmText} numberOfLines={1}>
              {STRINGS.bn.confirmDelete}
            </Text>
            <View style={styles.confirmActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.deleteConfirm,
                  (deleting || pressed) && styles.deleteConfirmDisabled,
                ]}
                onPress={onDeleteConfirm}
                disabled={deleting}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.delete}
              >
                <Text style={styles.deleteConfirmLabel}>
                  {deleting ? STRINGS.bn.running : STRINGS.bn.delete}
                </Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.deleteCancel,
                  pressed && styles.deleteCancelPressed,
                ]}
                onPress={onDeleteCancel}
                disabled={deleting}
                accessibilityRole="button"
                accessibilityLabel={STRINGS.bn.cancelDelete}
              >
                <Text style={styles.deleteCancelLabel}>
                  {STRINGS.bn.cancelDelete}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      <View style={styles.rowSide}>
        <Text style={styles.rowAmt} numberOfLines={1}>
          {formatTaka(item.amt, "bn")}
        </Text>
        <Switch
          value={item.active}
          onValueChange={onToggle}
          disabled={toggling || deleting}
          trackColor={{
            false: theme.colors.line,
            true: theme.colors.emerald,
          }}
          ios_backgroundColor={theme.colors.line}
          accessibilityLabel={`${item.cat} ${
            item.active ? STRINGS.bn.offLabel : STRINGS.bn.onLabel
          }`}
        />
        {!confirmDelete && (
          <Pressable
            style={({ pressed }) => [
              styles.deleteButton,
              pressed && styles.deleteButtonPressed,
            ]}
            onPress={onDeletePress}
            accessibilityRole="button"
            accessibilityLabel={`${STRINGS.bn.delete} ${item.cat}`}
          >
            <Text style={styles.deleteButtonLabel} numberOfLines={1}>
              {STRINGS.bn.delete}
            </Text>
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
  },
  brand: {
    color: theme.colors.onAccent,
    fontSize: 22,
    fontWeight: "700",
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
  runNote: {
    color: theme.colors.emerald,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  runButton: {
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.emerald,
    borderRadius: theme.radius.control,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  runButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  runButtonLabel: {
    color: theme.colors.emerald,
    fontSize: 16,
    fontWeight: "600",
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
  dateInput: {
    alignSelf: "flex-start",
    minWidth: 140,
    textAlign: "center",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
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
  rowTitle: {
    color: theme.colors.ink,
    fontSize: 16,
    fontWeight: "600",
    flexShrink: 1,
  },
  activeBadge: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  activeBadgeOn: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  activeBadgeOff: {
    backgroundColor: theme.colors.surface2,
  },
  activeBadgeLabel: {
    color: theme.colors.ink,
    fontSize: 11,
    fontWeight: "600",
  },
  rowDesc: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  rowFreq: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  rowMeta: {
    color: theme.colors.muted,
    fontSize: 12,
  },
  confirmBox: {
    marginTop: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  confirmText: {
    color: theme.colors.ink,
    fontSize: 13,
  },
  confirmActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  deleteConfirm: {
    backgroundColor: theme.colors.danger,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  deleteConfirmDisabled: {
    opacity: 0.5,
  },
  deleteConfirmLabel: {
    color: theme.colors.ivory,
    fontSize: 14,
    fontWeight: "600",
  },
  deleteCancel: {
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surface2,
  },
  deleteCancelPressed: {
    opacity: 0.8,
  },
  deleteCancelLabel: {
    color: theme.colors.muted,
    fontSize: 14,
    fontWeight: "600",
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
  deleteButton: {
    backgroundColor: theme.colors.dangerSoft,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  deleteButtonPressed: {
    opacity: 0.8,
  },
  deleteButtonLabel: {
    color: theme.colors.danger,
    fontSize: 12,
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
  footer: {
    alignItems: "center",
    gap: theme.spacing.md,
  },
  loadMoreButton: {
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  loadMoreButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  loadMoreLabel: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
  },
  backButton: {
    alignSelf: "center",
    marginTop: theme.spacing.xs,
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
