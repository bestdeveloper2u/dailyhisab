import { moneyFromNumber, t } from "@khoroch/core";
import { Redirect, useRouter } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { createExpense, type ExpenseGroup, type PayMethod } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { GROUP_LABELS, PAY_LABELS, STRINGS } from "../lib/strings";
import { theme } from "../lib/theme";

const GROUPS = Object.keys(GROUP_LABELS) as ExpenseGroup[];
const PAY_METHODS = Object.keys(PAY_LABELS) as PayMethod[];

/** ^\d+([.]\d{1,2})?$ — mirrors the API's numeric(12,2) domain. */
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

/** Add-expense screen wired to POST /api/v1/expenses (Bearer from AuthProvider). */
export default function AddExpense() {
  const auth = useAuth();
  const router = useRouter();

  const [amount, setAmount] = useState("");
  const [cat, setCat] = useState("");
  const [grp, setGrp] = useState<ExpenseGroup>("food");
  const [pay, setPay] = useState<PayMethod>("cash");
  const [iso, setIso] = useState(todayIso());
  const [desc, setDesc] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  const normalizedAmount = amount.trim().replace(/^৳\s*/, "");
  const validAmount = AMOUNT_RE.test(normalizedAmount) && Number(normalizedAmount) > 0;
  const validCat = cat.trim().length > 0;
  const validIso = isValidIso(iso.trim());
  const canSubmit = validAmount && validCat && validIso && !pending;

  async function handleSubmit() {
    const token = auth.accessToken;
    if (!canSubmit || !token) return;
    setPending(true);
    setError(null);
    try {
      const trimmedDesc = desc.trim();
      await createExpense(token, {
        cat: cat.trim(),
        grp,
        amt: moneyFromNumber(Number(normalizedAmount)), // "890" → "890.00"
        iso: iso.trim(),
        pay,
        desc: trimmedDesc.length > 0 ? trimmedDesc : null,
      });
      router.back(); // list reloads on focus
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>{STRINGS.bn.addTitle}</Text>

        <View style={styles.form}>
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

          <Text style={styles.label}>{STRINGS.bn.category}</Text>
          <TextInput
            style={styles.input}
            placeholder={STRINGS.bn.categoryPlaceholder}
            placeholderTextColor={theme.colors.muted}
            value={cat}
            onChangeText={setCat}
            editable={!pending}
          />

          <Text style={styles.label}>{STRINGS.bn.groupLabel}</Text>
          <View style={styles.chipWrap}>
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
          <View style={styles.chipWrap}>
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

          <Text style={styles.label}>{STRINGS.bn.dateLabel}</Text>
          <TextInput
            style={styles.input}
            value={iso}
            onChangeText={setIso}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            editable={!pending}
          />

          <Text style={styles.label}>{STRINGS.bn.descLabel}</Text>
          <TextInput
            style={styles.input}
            placeholder={STRINGS.bn.descPlaceholder}
            placeholderTextColor={theme.colors.muted}
            value={desc}
            onChangeText={setDesc}
            editable={!pending}
          />

          <Pressable
            style={({ pressed }) => [
              styles.submitButton,
              (!canSubmit || pressed) && styles.submitButtonDisabled,
              pressed && canSubmit && styles.submitButtonPressed,
            ]}
            onPress={() => void handleSubmit()}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityLabel={STRINGS.bn.save}
          >
            <Text style={styles.submitLabel}>
              {pending ? STRINGS.bn.saving : STRINGS.bn.save}
            </Text>
          </Pressable>
          {error !== null && <Text style={styles.errorText}>{error}</Text>}
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.backButtonPressed,
          ]}
          onPress={() => router.back()}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel={t("bn", "navDashboard")}
        >
          <Text style={styles.backLabel}>{t("bn", "navDashboard")}</Text>
        </Pressable>
      </ScrollView>
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  title: {
    color: theme.colors.ink,
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
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
    marginTop: theme.spacing.sm,
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
  chipWrap: {
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
    marginTop: theme.spacing.md,
  },
  submitButtonPressed: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: theme.colors.onAccent,
    fontSize: 16,
    fontWeight: "600",
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 13,
    textAlign: "center",
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
