import { moneyFromNumber, t as tCore } from "@khoroch/core";
import {
  Redirect,
  useLocalSearchParams,
  useRouter,
} from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  ApiError,
  createExpense,
  createExpensesBulk,
  listKhataCategories,
  voiceParse,
  type ExpenseCreateInput,
  type ExpenseGroup,
  type Khata,
  type ParsedExpense,
  type PayMethod,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { useAuth } from "../lib/auth";
import {
  clearExpenseDraft,
  loadExpenseDraft,
  saveExpenseDraft,
  type ExpenseDraft,
} from "../lib/draft";
import { usePrefs } from "../lib/prefs";
import {
  GROUP_LABELS,
  PAY_LABELS,
  STRINGS,
  type MobileStringKey,
} from "../lib/strings";
import { theme } from "../lib/theme";
import { useToast } from "../lib/toast";
import {
  loadSpeechModule,
  startVoiceSession,
  VOICE_PERMISSION_ERRORS,
  type VoiceSession,
} from "../lib/voice";

const GROUPS = Object.keys(GROUP_LABELS) as ExpenseGroup[];
const PAY_METHODS = Object.keys(PAY_LABELS) as PayMethod[];

/** T23.3 quick bump chips — the prototype's .qchips row under the amount
 *  input (www/index.html 782-785); bump(n) ADDS n to the parsed amount
 *  (www/index.html 1718). */
const BUMP_CHIPS: {
  n: number;
  labelKey: MobileStringKey;
  a11yKey: MobileStringKey;
}[] = [
  { n: 10, labelKey: "bump10", a11yKey: "bump10A11y" },
  { n: 50, labelKey: "bump50", a11yKey: "bump50A11y" },
  { n: 100, labelKey: "bump100", a11yKey: "bump100A11y" },
  { n: 500, labelKey: "bump500", a11yKey: "bump500A11y" },
];

/** ^\d+([.]\\d{1,2})?$ — mirrors the API's numeric(12,2) domain. */
const AMOUNT_RE = /^\d+([.]\d{1,2})?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Prototype parity: voice input is Bengali (settings "ভয়েস ভাষা: বাংলা"). */
const VOICE_LOCALE = "bn-BD";

/** Mic-button states: idle → listening → parsing → confirm sheet. */
type VoicePhase = "idle" | "listening" | "parsing" | "confirm";

/** Local device date as YYYY-MM-DD (T20.3 quick chips) — offsetDays −1 = yesterday. */
function localIso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso(): string {
  return localIso(0);
}

function isValidIso(value: string): boolean {
  if (!ISO_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Add-expense screen wired to POST /api/v1/expenses (Bearer from AuthProvider).
 *  T15.2 adds prototype voice parity: hold the mic, speak bn-BD, POST the
 *  transcript to /voice/parse, confirm the candidates, bulk-create them. */
export default function AddExpense() {
  const auth = useAuth();
  const router = useRouter();
  const { t } = usePrefs();
  const toast = useToast();
  // T22.3 — dashboard empty-CTA deep link: /add?voice=1.
  const { voice } = useLocalSearchParams<{ voice?: string }>();

  const [amount, setAmount] = useState("");
  const [cat, setCat] = useState("");
  const [grp, setGrp] = useState<ExpenseGroup>("food");
  const [pay, setPay] = useState<PayMethod>("cash");
  const [iso, setIso] = useState(todayIso());
  const [desc, setDesc] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Voice entry (T15.2) ----------------------------------------------------
  // null = probe still running; false = Expo Go / no dev build → show the
  // bn/en hint chip; the manual flow is completely unaffected either way.
  const [voiceSupported, setVoiceSupported] = useState<boolean | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voicePartial, setVoicePartial] = useState("");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceCandidates, setVoiceCandidates] = useState<ParsedExpense[]>([]);
  // Editable per-candidate amounts shown in the confirm sheet.
  const [voiceAmounts, setVoiceAmounts] = useState<string[]>([]);
  const [voiceSaving, setVoiceSaving] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceSession = useRef<VoiceSession | null>(null);

  useEffect(() => {
    void loadSpeechModule().then((mod) => setVoiceSupported(mod !== null));
  }, []);

  // T22.3 — auto-enter the recording phase when deep-linked with ?voice=1
  // from the dashboard empty-CTA. Single-shot via ref guard (safe under
  // StrictMode's double-invoked mount effects); fires only after the runtime
  // probe confirms voice support (ADR-0013 guard). Unsupported/unknown →
  // nothing happens: no auto-toast, the manual form is untouched.
  const autoVoiceStarted = useRef(false);
  useEffect(() => {
    if (autoVoiceStarted.current || voice !== "1" || voiceSupported !== true) {
      return;
    }
    autoVoiceStarted.current = true;
    void beginVoice();
    // beginVoice is hoisted and only touches idle-phase state on first run;
    // the single-shot ref covers re-runs from params/probe identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, voiceSupported]);

  // --- Draft autosave (T19.3 — web T19.2 twin) --------------------------------
  // The manual form is debounced-persisted to SecureStore; restored once on
  // mount (before any voice flow can fill fields) and erased on any
  // successful expense creation.
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced save: coalesce rapid keystrokes, persist the six-field snapshot
  // 300ms after the last manual change; an all-empty form erases the draft.
  function queueDraftSave(change: Partial<ExpenseDraft>) {
    const next: ExpenseDraft = { amount, cat, grp, pay, iso, desc, ...change };
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      const allEmpty =
        next.amount.trim().length === 0 &&
        next.cat.trim().length === 0 &&
        next.grp.trim().length === 0 &&
        next.pay.trim().length === 0 &&
        next.iso.trim().length === 0 &&
        next.desc.trim().length === 0;
      void saveExpenseDraft(allEmpty ? null : next);
    }, 300);
  }

  /** Drop a pending debounced save (post-create clear must win over it). */
  function cancelDraftSave() {
    if (draftTimer.current !== null) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
  }

  // Restore once on mount; guarded setters keep invalid/corrupt grp/pay from
  // clobbering the chip defaults. No-op when there is nothing stored.
  useEffect(() => {
    let cancelled = false;
    void loadExpenseDraft().then((draft) => {
      if (cancelled || draft === null) return;
      const hasAny =
        draft.amount.trim().length > 0 ||
        draft.cat.trim().length > 0 ||
        draft.grp.trim().length > 0 ||
        draft.pay.trim().length > 0 ||
        draft.iso.trim().length > 0 ||
        draft.desc.trim().length > 0;
      if (!hasAny) return;
      setAmount(draft.amount);
      setCat(draft.cat);
      if ((GROUPS as string[]).includes(draft.grp)) {
        setGrp(draft.grp as ExpenseGroup);
      }
      if ((PAY_METHODS as string[]).includes(draft.pay)) {
        setPay(draft.pay as PayMethod);
      }
      setIso(draft.iso);
      setDesc(draft.desc);
      toast(t("toastDraftRestored"));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the screen must not leave a timer that would resurrect the draft
  // after a successful create has already cleared it.
  useEffect(() => () => cancelDraftSave(), []);

  // --- Khata recents (T20.4-mob — web T20.4 twin) ------------------------------
  // Top 8 khatas fetched once on mount as prefill hints. Silent-fail: on any
  // error (or an empty history) the row simply never renders — the manual
  // form is never blocked on it.
  const [recents, setRecents] = useState<Khata[]>([]);

  useEffect(() => {
    const token = auth.accessToken;
    if (token === null) return;
    let cancelled = false;
    void listKhataCategories(token)
      .then((items) => {
        if (!cancelled) setRecents(items.slice(0, 8));
      })
      .catch(() => {
        // Recents are a convenience — swallow and hide the row.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetVoiceSheet() {
    setVoicePhase("idle");
    setVoiceCandidates([]);
    setVoiceAmounts([]);
    setVoicePartial("");
  }

  /** Final transcript → POST /voice/parse → confirm sheet (or inline hint). */
  async function handleVoiceFinal(text: string) {
    const token = auth.accessToken;
    const trimmed = text.trim();
    if (trimmed.length === 0 || token === null) {
      setVoicePhase("idle");
      return;
    }
    setVoicePartial("");
    setVoiceTranscript(trimmed);
    setVoicePhase("parsing");
    try {
      const parsed = await voiceParse(token, trimmed);
      if (parsed.items.length === 0) {
        setVoiceError(t("voiceNoItems"));
        setVoicePhase("idle");
        return;
      }
      setVoiceCandidates(parsed.items);
      setVoiceAmounts(parsed.items.map((item) => String(Number(item.amt))));
      setVoicePhase("confirm");
    } catch (err) {
      setVoiceError(describeApiError(err));
      setVoicePhase("idle");
    }
  }

  /** onPressIn — start the bn-BD recognizer (hold-to-record). */
  async function beginVoice() {
    if (voicePhase !== "idle" || pending) return;
    setVoiceError(null);
    setVoicePartial("");
    const session = await startVoiceSession(VOICE_LOCALE, {
      onPartial: (text) => setVoicePartial(text),
      onFinal: (text) => void handleVoiceFinal(text),
      onError: (code) => {
        setVoicePhase("idle");
        setVoicePartial("");
        if (code === "no-speech") {
          // Released without a word — not worth an error line, just reset.
          return;
        }
        setVoiceError(
          VOICE_PERMISSION_ERRORS.has(code)
            ? t("voicePermDenied")
            : t("voiceErr"),
        );
      },
    });
    if (session !== null) {
      voiceSession.current = session;
      setVoicePhase("listening");
    }
  }

  /** onPressOut — release the mic; the final transcript lands via onFinal. */
  function endVoice() {
    voiceSession.current?.stop();
    voiceSession.current = null;
  }

  /** Confirm sheet → bulk create (single-create fallback for older APIs). */
  async function confirmVoice() {
    const token = auth.accessToken;
    if (voiceSaving || token === null) return;
    const rows: ExpenseCreateInput[] = [];
    voiceCandidates.forEach((item, idx) => {
      const raw = (voiceAmounts[idx] ?? "").trim().replace(/^৳\s*/, "");
      const parsedAmt = Number(item.amt);
      const amt = AMOUNT_RE.test(raw) && Number(raw) > 0 ? Number(raw) : parsedAmt;
      if (!(amt > 0)) return; // skip a candidate whose amount went bad
      const trimmedCat = item.cat.trim();
      if (trimmedCat.length === 0) return;
      rows.push({
        cat: trimmedCat,
        grp: item.grp,
        amt: moneyFromNumber(amt), // 40 → "40.00"
        iso: item.iso ?? todayIso(),
        pay: item.pay ?? "cash",
        desc: item.desc ?? null,
      });
    });
    if (rows.length === 0) {
      setVoiceError(t("voiceNoItems"));
      resetVoiceSheet();
      return;
    }
    setVoiceSaving(true);
    try {
      try {
        await createExpensesBulk(token, rows);
      } catch (err) {
        // Older API builds without /expenses/bulk → loop single creates.
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
          for (const row of rows) {
            await createExpense(token, row);
          }
        } else {
          throw err;
        }
      }
      resetVoiceSheet();
      setVoiceTranscript("");
      cancelDraftSave();
      await clearExpenseDraft();
      toast(t("toastVoiceSaved"));
      router.back(); // list/dashboard reload on focus
    } catch (err) {
      setVoiceError(describeApiError(err));
      resetVoiceSheet();
    } finally {
      setVoiceSaving(false);
    }
  }

  if (!auth.user) {
    return <Redirect href="/login" />;
  }

  const normalizedAmount = amount.trim().replace(/^৳\s*/, "");
  const validAmount = AMOUNT_RE.test(normalizedAmount) && Number(normalizedAmount) > 0;
  const validCat = cat.trim().length > 0;
  const validIso = isValidIso(iso.trim());
  const canSubmit = validAmount && validCat && validIso && !pending;
  const voiceCanSave = voiceCandidates.length > 0 && !voiceSaving;
  // T20.3 quick-chip targets (local device dates, YYYY-MM-DD).
  const todayStr = localIso(0);
  const yesterdayStr = localIso(-1);

  function cancelVoiceSheet() {
    if (voiceSaving) return;
    resetVoiceSheet();
    setVoiceTranscript("");
    setVoiceError(null);
  }

  // T23.3 quick bump chips — prototype bump(n) parity: the new amount is
  // (parseInt(current, 10) || 0) + n, so an empty field starts from 0.
  // Normalization reuses the submit path's exact ৳-strip expression (the
  // `normalizedAmount` line below), and the write-back goes through
  // setAmount + queueDraftSave so the T19.3 draft autosave persists and
  // submit validation sees a clean ASCII value.
  function bumpAmount(n: number) {
    const current = parseInt(amount.trim().replace(/^৳\s*/, ""), 10) || 0;
    const next = String(current + n);
    setAmount(next);
    queueDraftSave({ amount: next });
  }

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
      cancelDraftSave();
      await clearExpenseDraft();
      toast(t("toastExpenseAdded"));
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
        <Text style={styles.subtitle} numberOfLines={1}>
          {t("addSub")}
        </Text>
        {voiceSupported === false && (
          <View style={styles.voiceChip} accessibilityRole="text">
            <Text style={styles.voiceChipLabel} numberOfLines={1}>
              🎙 {t("voiceUnavailable")}
            </Text>
          </View>
        )}

        <View style={styles.form}>
          <Text style={styles.label}>{STRINGS.bn.amount}</Text>
          <TextInput
            style={styles.input}
            placeholder={STRINGS.bn.amountPlaceholder}
            placeholderTextColor={theme.colors.muted}
            value={amount}
            onChangeText={(v) => {
              setAmount(v);
              queueDraftSave({ amount: v });
            }}
            keyboardType="decimal-pad"
            editable={!pending}
          />

          {/* T23.3 quick bump chips: +১০/+৫০/+১০০/+৫০০ directly under the
              amount input — prototype .qchips row parity; each tap ADDS to
              the parsed amount (bumpAmount). */}
          <View style={styles.bumpRow}>
            {BUMP_CHIPS.map(({ n, labelKey, a11yKey }) => (
              <Chip
                key={labelKey}
                label={t(labelKey)}
                selected={false}
                disabled={pending}
                onPress={() => bumpAmount(n)}
                style={styles.bumpChip}
                accessibilityLabel={t(a11yKey)}
              />
            ))}
          </View>

          {/* Khata recents (T20.4-mob): top-8 prefill chips, hidden until the
              categories fetch returns rows. Tap fills cat AND grp. */}
          {recents.length > 0 && (
            <View style={styles.recentsWrap}>
              <Text style={styles.recentsLabel}>{t("recentsLabel")}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentsScroll}
              >
                {recents.map((khata) => (
                  <Chip
                    key={khata.cat}
                    label={khata.cat}
                    selected={cat.trim() === khata.cat}
                    disabled={pending}
                    style={styles.recentChip}
                    onPress={() => {
                      setCat(khata.cat);
                      setGrp(khata.grp);
                      queueDraftSave({ cat: khata.cat, grp: khata.grp });
                    }}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          <Text style={styles.label}>{STRINGS.bn.category}</Text>
          <TextInput
            style={styles.input}
            placeholder={STRINGS.bn.categoryPlaceholder}
            placeholderTextColor={theme.colors.muted}
            value={cat}
            onChangeText={(v) => {
              setCat(v);
              queueDraftSave({ cat: v });
            }}
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
                onPress={() => {
                  setGrp(g);
                  queueDraftSave({ grp: g });
                }}
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
                onPress={() => {
                  setPay(p);
                  queueDraftSave({ pay: p });
                }}
              />
            ))}
          </View>

          <Text style={styles.label}>{STRINGS.bn.dateLabel}</Text>
          {/* T20.3 quick chips: আজ / গতকাল — local device dates. Selection is
              derived from iso, so any manual TextInput edit deactivates both. */}
          <View style={styles.chipWrap}>
            <Chip
              label={t("dayToday")}
              selected={iso.trim() === todayStr}
              disabled={pending}
              onPress={() => {
                setIso(todayStr);
                queueDraftSave({ iso: todayStr });
              }}
            />
            <Chip
              label={t("dayYesterday")}
              selected={iso.trim() === yesterdayStr}
              disabled={pending}
              onPress={() => {
                setIso(yesterdayStr);
                queueDraftSave({ iso: yesterdayStr });
              }}
            />
          </View>
          <TextInput
            style={styles.input}
            value={iso}
            onChangeText={(v) => {
              setIso(v);
              queueDraftSave({ iso: v });
            }}
            keyboardType="numbers-and-punctuation"
            maxLength={10}
            editable={!pending}
          />
          {/* T20.2 web twin hint — bn/en via prefs. */}
          <Text style={styles.dateHint}>{t("dateHint")}</Text>

          <Text style={styles.label}>{STRINGS.bn.descLabel}</Text>
          <TextInput
            style={styles.input}
            placeholder={STRINGS.bn.descPlaceholder}
            placeholderTextColor={theme.colors.muted}
            value={desc}
            onChangeText={(v) => {
              setDesc(v);
              queueDraftSave({ desc: v });
            }}
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

        {/* Voice entry (T15.2 — prototype mic parity): hold to record. */}
        {voiceSupported !== false && (
          <View style={styles.voiceArea}>
            {voiceError !== null && (
              <Text style={styles.voiceError} numberOfLines={2}>
                {voiceError}
              </Text>
            )}
            <Pressable
              style={({ pressed }) => [
                styles.micButton,
                voicePhase === "listening" && styles.micButtonActive,
                pressed && voicePhase === "idle" && styles.micButtonPressed,
              ]}
              onPressIn={() => void beginVoice()}
              onPressOut={endVoice}
              disabled={pending || voicePhase === "parsing" || voicePhase === "confirm"}
              accessibilityRole="button"
              accessibilityLabel={t("voiceHoldHint")}
              accessibilityState={{ busy: voicePhase === "listening" }}
            >
              <Text style={styles.micIcon}>🎙</Text>
            </Pressable>
            <Text style={styles.voiceCaption} numberOfLines={1}>
              {voicePhase === "listening"
                ? t("voiceListening")
                : voicePhase === "parsing"
                  ? t("voiceParsing")
                  : t("voiceHoldHint")}
            </Text>
            {voicePartial.length > 0 && (
              <Text style={styles.voicePartial} numberOfLines={1}>
                “{voicePartial}”
              </Text>
            )}
          </View>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.backButtonPressed,
          ]}
          onPress={() => router.back()}
          disabled={pending}
          accessibilityRole="button"
          accessibilityLabel={tCore("bn", "navDashboard")}
        >
          <Text style={styles.backLabel}>{tCore("bn", "navDashboard")}</Text>
        </Pressable>
      </ScrollView>

      {/* Voice confirm sheet (T15.2 — prototype vpConfirm parity): parsed
          candidates with editable amounts before the bulk create. */}
      <Modal
        visible={voicePhase === "confirm"}
        animationType="slide"
        transparent
        onRequestClose={cancelVoiceSheet}
      >
        <View style={styles.sheetHost}>
          <View style={styles.scrim} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{t("voiceHeard")}</Text>
            <Text style={styles.sheetTranscript} numberOfLines={2}>
              “{voiceTranscript}”
            </Text>
            <Text style={styles.sheetLabel}>{STRINGS.bn.amount}</Text>
            <View style={styles.sheetRows}>
              {voiceCandidates.map((item, idx) => (
                <View style={styles.sheetRow} key={`${item.cat}-${idx}`}>
                  <Text style={styles.sheetCat} numberOfLines={1}>
                    {item.cat} · {GROUP_LABELS[item.grp] ?? item.grp}
                  </Text>
                  <TextInput
                    style={styles.sheetInput}
                    value={voiceAmounts[idx] ?? ""}
                    onChangeText={(next) =>
                      setVoiceAmounts((prev) =>
                        prev.map((value, i) => (i === idx ? next : value)),
                      )
                    }
                    keyboardType="decimal-pad"
                    placeholder={STRINGS.bn.amountPlaceholder}
                    placeholderTextColor={theme.colors.muted}
                    editable={!voiceSaving}
                  />
                </View>
              ))}
            </View>
            <View style={styles.sheetActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.sheetCancel,
                  pressed && styles.sheetCancelPressed,
                ]}
                onPress={cancelVoiceSheet}
                disabled={voiceSaving}
                accessibilityRole="button"
                accessibilityLabel={t("cancel")}
              >
                <Text style={styles.sheetCancelLabel}>{t("cancel")}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.sheetSave,
                  (!voiceCanSave || pressed) && styles.sheetSaveDisabled,
                  pressed && voiceCanSave && styles.sheetSavePressed,
                ]}
                onPress={() => void confirmVoice()}
                disabled={!voiceCanSave}
                accessibilityRole="button"
                accessibilityLabel={t("voiceSaveAll")}
              >
                <Text style={styles.sheetSaveLabel}>
                  {voiceSaving ? STRINGS.bn.saving : t("voiceSaveAll")}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function Chip({
  label,
  selected,
  disabled,
  onPress,
  style,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  /** Optional extra container style (e.g. recents-chip maxWidth). */
  style?: StyleProp<ViewStyle>;
  /** Optional screen-reader label (T23.3 bump chips — "+১০ টাকা যোগ করুন"). */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && !disabled && styles.chipPressed,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={accessibilityLabel}
    >
      {/* numberOfLines=1 keeps long khata names (T20.4 recents) from wrapping
          or overflowing the chip; short labels are unaffected. */}
      <Text
        style={[styles.chipLabel, selected && styles.chipLabelSelected]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
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
  // --- Amount quick-bump chips (T23.3 — prototype .qchips parity) -----------
  bumpRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  /** flex:1 keeps all four chips on one row at 360 dp; minHeight 44 meets the
      touch-target floor. Same tokens as the আজ/গতকাল chips (styles.chip*). */
  bumpChip: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing.sm,
  },
  // --- Khata recents (T20.4-mob) -------------------------------------------
  recentsWrap: {
    gap: theme.spacing.sm,
  },
  recentsLabel: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  recentsScroll: {
    alignItems: "center",
    gap: theme.spacing.sm,
    flexGrow: 1,
  },
  recentChip: {
    maxWidth: 220,
  },
  // --- Date quick chips (T20.3) ---------------------------------------------
  dateHint: {
    color: theme.colors.muted,
    fontSize: 12,
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
  // --- Voice entry (T15.2) -----------------------------------------------
  subtitle: {
    color: theme.colors.muted,
    fontSize: 13,
    textAlign: "center",
  },
  voiceChip: {
    alignSelf: "center",
    backgroundColor: theme.colors.warningSoft,
    borderRadius: theme.radius.control,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  voiceChipLabel: {
    color: theme.colors.warning,
    fontSize: 12,
    fontWeight: "600",
  },
  voiceArea: {
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.md,
  },
  voiceError: {
    color: theme.colors.danger,
    fontSize: 13,
    textAlign: "center",
  },
  micButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: theme.colors.emerald,
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonActive: {
    backgroundColor: theme.colors.danger,
  },
  micButtonPressed: {
    opacity: 0.85,
  },
  micIcon: {
    fontSize: 30,
  },
  voiceCaption: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  voicePartial: {
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  sheetHost: {
    flex: 1,
    justifyContent: "flex-end",
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.ink,
    opacity: 0.45,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.card,
    borderTopRightRadius: theme.radius.card,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  sheetTitle: {
    color: theme.colors.muted,
    fontSize: 13,
    textAlign: "center",
  },
  sheetTranscript: {
    color: theme.colors.ink,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  sheetLabel: {
    color: theme.colors.muted,
    fontSize: 13,
  },
  sheetRows: {
    gap: theme.spacing.sm,
  },
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  sheetCat: {
    flex: 1,
    color: theme.colors.ink,
    fontSize: 14,
    fontWeight: "600",
  },
  sheetInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.line,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.ink,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    fontSize: 15,
    width: 130,
    textAlign: "center",
  },
  sheetActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  sheetCancel: {
    flex: 1,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  sheetCancelPressed: {
    opacity: 0.8,
  },
  sheetCancelLabel: {
    color: theme.colors.muted,
    fontSize: 15,
    fontWeight: "600",
  },
  sheetSave: {
    flex: 1,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.emerald,
    alignItems: "center",
    paddingVertical: theme.spacing.md,
  },
  sheetSavePressed: {
    backgroundColor: theme.colors.emeraldSoft,
  },
  sheetSaveDisabled: {
    opacity: 0.5,
  },
  sheetSaveLabel: {
    color: theme.colors.onAccent,
    fontSize: 15,
    fontWeight: "600",
  },
});
