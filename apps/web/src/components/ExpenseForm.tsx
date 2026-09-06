import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { t } from "@khoroch/core";
import type { Expense, ExpenseGroup, Khata, PayMethod } from "@khoroch/api-client";
import { useExpenseMutations, useKhataCategories } from "../lib/queries";
import {
  BUMP_STEPS,
  GROUP_LABELS,
  GROUP_ORDER,
  groupName,
  PAY_LABELS,
  bumpAmount,
  normalizeAmount,
  todayIso,
  yesterdayIso,
} from "../lib/catalog";
import { normalizeAmountInput } from "../lib/num";
import {
  clearExpenseDraft,
  DRAFT_RESTORED_MSG,
  loadExpenseDraft,
  saveExpenseDraft,
} from "../lib/draft";
import { w } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";
import { toast } from "../lib/toast";
import { fetchExpensesForDays, findDuplicateExpenses } from "../lib/duplicate";
import { fmtTaka } from "../lib/money";
import { Modal } from "./Modal";

const inputClass =
  "w-full rounded-control border border-line bg-ivory px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none";

/** APG combobox: at most 8 history-derived suggestions (ADR-0019). */
const KHATA_MATCH_LIMIT = 8;
const CAT_LISTBOX_ID = "exp-cat-listbox";
const catOptionId = (index: number) => `exp-cat-option-${index}`;
/** Stable empty list so the `matches` memo never churns on a failed fetch. */
const NO_KHATAS: Khata[] = [];

interface ExpenseFormProps {
  open: boolean;
  onClose: () => void;
  /** Present → edit (PATCH); absent → create (POST). */
  expense?: Expense | null;
}

/**
 * Manual add/edit form mirroring the prototype's add screen: big amount
 * first, then khata/group, payment, date and an optional note. Money is
 * validated client-side and sent as a 2-decimal STRING (ADR-0004 §1).
 */
export function ExpenseForm({ open, onClose, expense }: ExpenseFormProps) {
  const lang = useLangStore((s) => s.lang);
  const { create, update } = useExpenseMutations();

  const [amt, setAmt] = useState(expense ? String(Number(expense.amt)) : "");
  const [cat, setCat] = useState(expense?.cat ?? "");
  const [grp, setGrp] = useState<ExpenseGroup>(expense?.grp ?? "food");
  const [pay, setPay] = useState<PayMethod>(expense?.pay ?? "cash");
  const [iso, setIso] = useState(expense?.iso ?? todayIso());
  const [desc, setDesc] = useState(expense?.desc ?? "");
  const [error, setError] = useState<string | null>(null);
  // T24.1 — the already-saved expense the duplicate guard matched (null =
  // nothing matched / not checked yet). Non-null turns the next submit into
  // an explicit "তবুও যোগ করুন" confirmation (WCAG 2.2 SC 3.3.4).
  const [dupExisting, setDupExisting] = useState<Expense | null>(null);
  // Field signature the confirmation was given for — any change re-arms the
  // guard, so a stale confirmation can never bless different values.
  const dupSigRef = useRef("");

  const pending = create.isPending || update.isPending;

  // T20.4 — history-derived khata suggestions (ADR-0019). A failed/empty
  // list degrades to no suggestions at all: the popup never renders and the
  // form keeps working exactly as before (silent fail by design).
  const categoriesQuery = useKhataCategories();
  const khatas = categoriesQuery.data?.ok
    ? categoriesQuery.data.data.items
    : NO_KHATAS;
  const [catListOpen, setCatListOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Case-insensitive substring match over the fetched khatas, API order
  // preserved (most-used → most-recent → cat), capped at 8.
  const catQuery = cat.trim().toLowerCase();
  const matches = useMemo(
    () =>
      catQuery === ""
        ? []
        : khatas
            .filter((k) => k.cat.toLowerCase().includes(catQuery))
            .slice(0, KHATA_MATCH_LIMIT),
    [khatas, catQuery],
  );

  // The popup exists only while the user typed something AND there are
  // matches: a restored draft (T19.2) fills state without ever opening it.
  const popupOpen = catListOpen && matches.length > 0;
  const active = popupOpen ? Math.min(activeIdx, matches.length - 1) : -1;

  /** Pick a suggestion: fill খাত + the khata's most-recent group (ADR-0019). */
  function applyKhata(khata: Khata) {
    setCat(khata.cat);
    setGrp(khata.grp);
    setCatListOpen(false);
    setActiveIdx(0);
  }

  // T19.2 draft autosave — CREATE mode only; edit mode never reads or
  // writes the draft (the form remounts per target via `key`, so the
  // create/edit split is stable within one mount).
  const isCreate = !expense;

  // Restore on open: a saved draft with any non-empty typed field wins
  // over the blank defaults. Selects/date always carry a value, so amt /
  // cat / desc decide whether this is a real draft.
  useEffect(() => {
    if (!open || !isCreate) return;
    const draft = loadExpenseDraft();
    if (!draft) return;
    if (draft.amt === "" && draft.cat === "" && draft.desc === "") return;
    setAmt(draft.amt);
    setCat(draft.cat);
    if (GROUP_ORDER.includes(draft.grp as ExpenseGroup)) setGrp(draft.grp as ExpenseGroup);
    if (draft.pay in PAY_LABELS) setPay(draft.pay as PayMethod);
    if (draft.iso !== "") setIso(draft.iso);
    setDesc(draft.desc);
    saveExpenseDraft(draft); // re-arm immediately in case a re-render is delayed
    toast(DRAFT_RESTORED_MSG[useLangStore.getState().lang]);
  }, [open, isCreate]);

  // Debounced autosave (300ms): every change persists the draft; an
  // all-empty form clears it. Closed modal / edit mode never saves.
  useEffect(() => {
    if (!open || !isCreate) return;
    const timer = setTimeout(() => {
      saveExpenseDraft(
        amt === "" && cat === "" && desc === ""
          ? null
          : { amt, cat, grp, pay, iso, desc },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [open, isCreate, amt, cat, grp, pay, iso, desc]);

  /** Close wrapper: dropping an all-empty create form clears any draft. */
  function handleClose() {
    if (isCreate && amt === "" && cat === "" && desc === "") clearExpenseDraft();
    dupSigRef.current = ""; // T24.1: a reopened form is never pre-confirmed
    setDupExisting(null);
    onClose();
  }

  // T24.1: editing amount/khata/date re-arms the guard — the confirmation
  // was for those exact values, and changed values must be re-checked.
  useEffect(() => {
    if (dupExisting !== null && dupSigRef.current !== `${amt}|${cat}|${iso}`) {
      dupSigRef.current = "";
      setDupExisting(null);
    }
  }, [amt, cat, iso, dupExisting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // T15.1b: accept Bengali digits / ৳ / commas; then validate + pad to 2dp.
    const amtStr = normalizeAmount(normalizeAmountInput(amt));
    if (amtStr === null) {
      setError(w(lang, "errAmt"));
      return;
    }
    const catTrimmed = cat.trim();
    if (!catTrimmed) {
      setError(w(lang, "errCat"));
      return;
    }

    if (expense) {
      const res = await update.mutateAsync({
        id: expense.id,
        body: { amt: amtStr, cat: catTrimmed, grp, pay, iso, desc: desc.trim() || null },
      });
      if (res.ok) {
        toast(t(lang, "savedCheck"));
        onClose();
        return;
      }
      setError(res.detail || w(lang, "errFallback"));
    } else {
      // T24.1 — duplicate-add guard (WCAG 2.2 SC 3.3.4 "checked",
      // https://www.w3.org/TR/WCAG22/#error-prevention-legal-financial-data):
      // before a create, compare against that day's saved expenses; on a
      // match the first submit only shows a warning and the button becomes
      // "তবুও যোগ করুন" — the re-add goes through only on an explicit second
      // submit. A failed guard fetch degrades to no-check (fail-open) and
      // edit mode is never guarded (that row is being changed on purpose).
      if (dupExisting === null) {
        const recent = await fetchExpensesForDays([iso], lang);
        const [hit] = findDuplicateExpenses({ amt: amtStr, cat: catTrimmed, iso }, recent);
        if (hit) {
          dupSigRef.current = `${amt}|${cat}|${iso}`;
          setDupExisting(hit);
          return;
        }
      }
      setDupExisting(null);
      // T20.2 optimistic create: the row is already in the list cache (see
      // useExpenseMutations); a server rejection throws here after rollback.
      try {
        await create.mutateAsync({
          amt: amtStr,
          cat: catTrimmed,
          grp,
          pay,
          iso,
          desc: desc.trim() || null,
        });
        clearExpenseDraft(); // T19.2: a saved expense is no longer a draft
        setAmt("");
        setCat("");
        setDesc("");
        toast(w(lang, "tSaved"));
        onClose();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : w(lang, "errFallback"));
      }
    }
  }

  return (
    <Modal open={open} onClose={handleClose} label={w(lang, expense ? "editTitle" : "addTitle")}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5" aria-busy={pending}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">{w(lang, expense ? "editTitle" : "addTitle")}</h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label={w(lang, "cancel")}
            className="rounded-control px-2 py-1 text-sm font-semibold text-muted hover:bg-surface-2"
          >
            ✕
          </button>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-control border border-danger bg-danger/5 px-3.5 py-2.5 text-sm font-medium text-danger"
          >
            {error}
          </p>
        )}

        {/* T24.1 duplicate guard (WCAG 2.2 SC 3.3.4): a checked submission —
            the save waits for the explicit "তবুও যোগ করুন" tap below. */}
        {dupExisting && (
          <div
            role="alert"
            className="rounded-control border border-warning bg-warning/5 px-3.5 py-2.5 text-sm text-ink"
          >
            <p className="font-bold text-warning">{w(lang, "dupTitle")}</p>
            <p>
              {w(lang, "dupFormWarn")}{" "}
              <span className="font-semibold">
                {dupExisting.cat} · {fmtTaka(dupExisting.amt, lang)}
              </span>
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-muted" htmlFor="exp-amt">
            {w(lang, "amtLabel")}
          </label>
          <input
            id="exp-amt"
            name="amt"
            type="text"
            inputMode="decimal"
            required
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            placeholder={w(lang, "amtPh")}
            className="rounded-control border border-line bg-ivory px-3.5 py-3 text-2xl font-bold tabular-nums text-ink placeholder:text-muted/50 focus:border-emerald focus:outline-none"
          />
          {/* Quick +amount chips (prototype qchips @783-784). */}
          <div
            role="group"
            aria-label={w(lang, "bumpLabel")}
            className="flex flex-wrap gap-1.5"
          >
            {BUMP_STEPS.map((step) => (
              <button
                key={step.key}
                type="button"
                onClick={() => setAmt(bumpAmount(normalizeAmountInput(amt), step.add))}
                className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-emerald hover:text-emerald"
              >
                {w(lang, step.key)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="relative flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted" htmlFor="exp-cat">
              {w(lang, "catLabel")}
            </label>
            <input
              id="exp-cat"
              name="cat"
              type="text"
              required
              maxLength={80}
              value={cat}
              role="combobox"
              autoComplete="off"
              aria-expanded={popupOpen}
              aria-controls={popupOpen ? CAT_LISTBOX_ID : undefined}
              aria-autocomplete="list"
              aria-activedescendant={popupOpen ? catOptionId(active) : undefined}
              onChange={(e) => {
                setCat(e.target.value);
                setActiveIdx(0);
                setCatListOpen(true); // typing (re)opens; state fills never do
              }}
              onKeyDown={(e) => {
                if (!popupOpen) return; // closed: Escape/Enter keep modal/submit semantics
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActiveIdx(Math.min(active + 1, matches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActiveIdx(Math.max(active - 1, 0));
                } else if (e.key === "Enter") {
                  const pick = matches[active];
                  if (pick) {
                    e.preventDefault(); // picking a suggestion never submits
                    applyKhata(pick);
                  }
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  // Close only the popup: the Modal listens for Escape on
                  // `window`, so stop the event before it gets there or the
                  // whole dialog would close.
                  e.stopPropagation();
                  setCatListOpen(false);
                } else if (e.key === "Tab") {
                  setCatListOpen(false); // focus moves on, popup follows
                }
              }}
              onBlur={() => setCatListOpen(false)}
              placeholder={w(lang, "catPh")}
              className={inputClass}
            />
            {popupOpen && (
              <ul
                id={CAT_LISTBOX_ID}
                role="listbox"
                aria-label={w(lang, "khataSuggestionsLabel")}
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-control border border-line bg-surface py-1 shadow-card"
              >
                {matches.map((k, i) => (
                  <li
                    key={k.cat}
                    id={catOptionId(i)}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      // Selection must land before the input's blur hides
                      // the popup — preventDefault keeps focus in the input.
                      e.preventDefault();
                      applyKhata(k);
                    }}
                    className={`flex cursor-pointer items-center justify-between gap-2 px-3.5 py-2 text-sm text-ink ${
                      i === active ? "bg-surface-2 font-semibold" : ""
                    }`}
                  >
                    <span className="truncate">{k.cat}</span>{" "}
                    <span className="shrink-0 text-xs text-muted">
                      {groupName(k.grp, lang)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted" htmlFor="exp-grp">
              {w(lang, "grpLabel")}
            </label>
            <select
              id="exp-grp"
              name="grp"
              value={grp}
              onChange={(e) => setGrp(e.target.value as ExpenseGroup)}
              className={inputClass}
            >
              {GROUP_ORDER.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABELS[g][lang]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted" htmlFor="exp-pay">
              {w(lang, "payLabel")}
            </label>
            <select
              id="exp-pay"
              name="pay"
              value={pay}
              onChange={(e) => setPay(e.target.value as PayMethod)}
              className={inputClass}
            >
              {(Object.keys(PAY_LABELS) as PayMethod[]).map((p) => (
                <option key={p} value={p}>
                  {PAY_LABELS[p][lang]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted" htmlFor="exp-iso">
              {w(lang, "dateLabel")}
            </label>
            <input
              id="exp-iso"
              name="iso"
              type="date"
              required
              value={iso}
              onChange={(e) => setIso(e.target.value)}
              className={inputClass}
            />
            {/* আজ/গতকাল quick-date chips (prototype datechips @797-799, T20.2). */}
            <div role="group" aria-label={w(lang, "dateChipsLabel")} className="flex gap-1.5">
              <button
                type="button"
                aria-pressed={iso === todayIso()}
                onClick={() => setIso(todayIso())}
                className="rounded-full border border-line bg-surface px-3.5 py-1 text-[13px] font-semibold text-muted transition-colors hover:border-emerald hover:text-emerald aria-pressed:border-emerald aria-pressed:bg-emerald aria-pressed:text-accent-ink"
              >
                {w(lang, "dayToday")}
              </button>
              <button
                type="button"
                aria-pressed={iso === yesterdayIso()}
                onClick={() => setIso(yesterdayIso())}
                className="rounded-full border border-line bg-surface px-3.5 py-1 text-[13px] font-semibold text-muted transition-colors hover:border-emerald hover:text-emerald aria-pressed:border-emerald aria-pressed:bg-emerald aria-pressed:text-accent-ink"
              >
                {w(lang, "dayYesterday")}
              </button>
            </div>
            <p className="px-1 text-xs text-muted">{w(lang, "dateHint")}</p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-muted" htmlFor="exp-desc">
            {w(lang, "descLabel")}
          </label>
          <input
            id="exp-desc"
            name="desc"
            type="text"
            maxLength={200}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder={w(lang, "descPh")}
            className={inputClass}
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="h-12 rounded-control bg-emerald font-bold text-accent-ink transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending
            ? w(lang, "saving")
            : dupExisting !== null
              ? w(lang, "dupAddAnyway")
              : w(lang, "save")}
        </button>
      </form>
    </Modal>
  );
}
