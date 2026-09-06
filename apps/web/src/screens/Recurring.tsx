import { useMemo, useState } from "react";
import { moneyToNumber, t, toBnDigits } from "@khoroch/core";
import type { ApiResult, Recurring } from "@khoroch/api-client";
import {
  useRecurringInfinite,
  useRecurringMutations,
  type RecurringFilter,
} from "../lib/queries";
import {
  dayLabel,
  groupDot,
  GROUP_LABELS,
  GROUP_ORDER,
  normalizeAmount,
  PAY_LABELS,
  PAY_ORDER,
  todayIso,
} from "../lib/catalog";
import { normalizeAmountInput } from "../lib/num";
import { w } from "../lib/web-i18n";
import { fmtTaka } from "../lib/money";
import { usePageTitle } from "../lib/usePageTitle";
import { useLangStore } from "../store/lang";
import { Modal } from "../components/Modal";
import { Segmented } from "../components/Segmented";
import { toast } from "../lib/toast";
import { IconPencil, IconPlay, IconPlus, IconTrash } from "../components/icons";

type RuleGrp = Recurring["grp"];
type RulePay = Recurring["pay"];
type RuleFreq = Recurring["freq"];

const FILTER_KEY = { all: "filterAll", active: "rActive", paused: "rPaused" } as const;
const FREQ_KEY = {
  daily: "rFreqDaily",
  weekly: "rFreqWeekly",
  monthly: "rFreqMonthly",
  yearly: "rFreqYearly",
} as const satisfies Record<RuleFreq, string>;

/** Compose "৫টি খরচ যোগ হয়েছে ✓" / "5 expenses created ✓" (mobile parity). */
function runToastText(created: number, lang: "bn" | "en"): string {
  const count = lang === "bn" ? toBnDigits(String(created)) : String(created);
  const sep = lang === "bn" ? "" : " "; // bn digits bind tight (৫টি), en needs "5 expenses"
  return `${count}${sep}${w(lang, "rRunSuffix")}`;
}

/** Two-step delete (arm → confirm), mirroring the debts list. */
function DeleteRuleButton({ rule }: { rule: Recurring }) {
  const lang = useLangStore((s) => s.lang);
  const { remove } = useRecurringMutations();
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        aria-label={`${rule.cat} — ${w(lang, "remove")}`}
        onClick={() => setArmed(true)}
        className="rounded-control p-2 text-muted hover:bg-surface-2 hover:text-danger"
      >
        <IconTrash className="h-4 w-4" />
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() =>
          remove.mutate(rule.id, {
            onSuccess: (res) => {
              if (res.ok) {
                setArmed(false);
                toast(w(lang, "tDeleted"));
              } else {
                toast(res.detail || w(lang, "rErrSave"));
              }
            },
            onError: () => toast(w(lang, "rErrSave")),
          })
        }
        className="rounded-control bg-danger px-2 py-1.5 text-xs font-bold text-accent-ink disabled:opacity-60"
      >
        {w(lang, "confirmDelete")}
      </button>
      <button
        type="button"
        onClick={() => setArmed(false)}
        aria-label={w(lang, "cancel")}
        className="rounded-control px-1.5 py-1.5 text-xs font-semibold text-muted hover:bg-surface-2"
      >
        ✕
      </button>
    </span>
  );
}

/** Add/edit dialog. `rule === null` → create mode (prefills today's date). */
function RuleFormModal({ rule, onClose }: { rule: Recurring | null; onClose: () => void }) {
  const lang = useLangStore((s) => s.lang);
  const { create, update } = useRecurringMutations();
  const [cat, setCat] = useState(rule?.cat ?? "");
  const [grp, setGrp] = useState<RuleGrp>(rule?.grp ?? "food");
  const [amt, setAmt] = useState(rule ? moneyToNumber(rule.amt).toString() : "");
  const [pay, setPay] = useState<RulePay>(rule?.pay ?? "cash");
  const [freq, setFreq] = useState<RuleFreq>(rule?.freq ?? "monthly");
  const [start, setStart] = useState(rule?.start_date ?? todayIso());
  const [desc, setDesc] = useState(rule?.desc ?? "");
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  function submit() {
    // T15.1b parity: accept Bengali digits / ৳ / commas, then pad to 2dp.
    const normalized = normalizeAmount(normalizeAmountInput(amt));
    if (!cat.trim()) {
      setError(w(lang, "errCat"));
      return;
    }
    if (!normalized || moneyToNumber(normalized) <= 0) {
      setError(w(lang, "errAmt"));
      return;
    }
    setError(null);
    const body = {
      cat: cat.trim().slice(0, 120),
      grp,
      amt: normalized,
      pay,
      freq,
      desc: desc.trim() ? desc.trim().slice(0, 200) : null,
      start_date: start || todayIso(),
    };
    const onError = () => setError(w(lang, "rErrSave"));
    const onSuccess = (res: ApiResult<Recurring>) => {
      if (res.ok) {
        toast(t(lang, "savedCheck"));
        onClose();
      } else {
        setError(res.detail || w(lang, "rErrSave"));
      }
    };
    if (rule) {
      update.mutate({ id: rule.id, body }, { onSuccess, onError });
    } else {
      create.mutate(body, { onSuccess, onError });
    }
  }

  return (
    <Modal open onClose={onClose} label={rule ? w(lang, "rEditTitle") : w(lang, "rAddTitle")}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 className="text-lg font-bold">
          {rule ? w(lang, "rEditTitle") : w(lang, "rAddTitle")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="ruleCat" className="text-[13px] font-semibold text-muted">
              {w(lang, "catLabel")}
            </label>
            <input
              id="ruleCat"
              type="text"
              value={cat}
              onChange={(e) => setCat(e.target.value)}
              placeholder={w(lang, "catPh")}
              maxLength={120}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="ruleAmt" className="text-[13px] font-semibold text-muted">
              {w(lang, "amtLabel")}
            </label>
            <input
              id="ruleAmt"
              type="text"
              inputMode="decimal"
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              placeholder={w(lang, "amtPh")}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-lg font-bold tabular-nums text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="ruleFreq" className="text-[13px] font-semibold text-muted">
              {w(lang, "rFreq")}
            </label>
            <select
              id="ruleFreq"
              value={freq}
              onChange={(e) => setFreq(e.target.value as RuleFreq)}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-emerald focus:outline-none"
            >
              {(Object.keys(FREQ_KEY) as RuleFreq[]).map((f) => (
                <option key={f} value={f}>
                  {w(lang, FREQ_KEY[f])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ruleGrp" className="text-[13px] font-semibold text-muted">
              {w(lang, "grpLabel")}
            </label>
            <select
              id="ruleGrp"
              value={grp}
              onChange={(e) => setGrp(e.target.value as RuleGrp)}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-emerald focus:outline-none"
            >
              {GROUP_ORDER.map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABELS[g][lang]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rulePay" className="text-[13px] font-semibold text-muted">
              {w(lang, "payLabel")}
            </label>
            <select
              id="rulePay"
              value={pay}
              onChange={(e) => setPay(e.target.value as RulePay)}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-emerald focus:outline-none"
            >
              {PAY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PAY_LABELS[p][lang]}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="ruleStart" className="text-[13px] font-semibold text-muted">
              {w(lang, "rStart")}
            </label>
            <input
              id="ruleStart"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value || todayIso())}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-emerald focus:outline-none"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="ruleDesc" className="text-[13px] font-semibold text-muted">
              {w(lang, "descLabel")}
            </label>
            <input
              id="ruleDesc"
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={w(lang, "descPh")}
              maxLength={200}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
            />
          </div>
        </div>
        {error && (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-control border border-line px-4 py-2.5 text-sm font-semibold text-muted hover:bg-surface-2"
          >
            {w(lang, "cancel")}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="rounded-control bg-emerald px-4 py-2.5 text-sm font-bold text-accent-ink hover:brightness-110 disabled:opacity-60"
          >
            {pending ? w(lang, "saving") : w(lang, "save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One rule row: group dot, cat + badges, schedule line, amount, actions. */
function RuleRow({ rule, onEdit }: { rule: Recurring; onEdit: (rule: Recurring) => void }) {
  const lang = useLangStore((s) => s.lang);
  const { update } = useRecurringMutations();

  function toggleActive() {
    update.mutate(
      { id: rule.id, body: { active: !rule.active } },
      {
        onSuccess: (res) => {
          if (!res.ok) toast(res.detail || w(lang, "rErrSave"));
        },
        onError: () => toast(w(lang, "rErrSave")),
      },
    );
  }

  return (
    <li className="flex items-center gap-3 px-3.5 py-3">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: groupDot(rule.grp) }}
      />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-semibold">
          {rule.cat}
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
              rule.active ? "bg-emerald-soft text-emerald" : "bg-surface-2 text-muted"
            }`}
          >
            {rule.active ? w(lang, "rActive") : w(lang, "rPaused")}
          </span>
        </p>
        <p className="truncate text-xs text-muted">
          {w(lang, FREQ_KEY[rule.freq])} · {w(lang, "rNext")} {dayLabel(rule.next_run, lang)}
          {rule.desc ? ` · ${rule.desc}` : ""}
        </p>
      </div>
      <span className="shrink-0 text-sm font-bold tabular-nums">{fmtTaka(rule.amt, lang)}</span>
      {/* Active toggle — a switch, so the state is announced (WCAG 4.1.2). */}
      <button
        type="button"
        role="switch"
        aria-checked={rule.active}
        aria-label={`${rule.cat} — ${rule.active ? w(lang, "rActive") : w(lang, "rPaused")}`}
        disabled={update.isPending}
        onClick={toggleActive}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${
          rule.active ? "bg-emerald" : "bg-line"
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-card transition-all ${
            rule.active ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
      <button
        type="button"
        aria-label={`${rule.cat} — ${w(lang, "edit")}`}
        onClick={() => onEdit(rule)}
        className="rounded-control p-2 text-muted hover:bg-surface-2 hover:text-ink"
      >
        <IconPencil className="h-4 w-4" />
      </button>
      <DeleteRuleButton rule={rule} />
    </li>
  );
}

/**
 * Recurring screen (পুনরাবৃত্ত খরচ — T16.4, ADR-0014): filterable rule list
 * with add/edit, active pause/resume switch, two-step delete, and a run-now
 * button that materializes due occurrences through the real /api/v1/recurring
 * endpoints.
 */
export function Recurring() {
  const lang = useLangStore((s) => s.lang);
  usePageTitle(`${w(lang, "rTitle")} · Daily Hisab`);
  const { run } = useRecurringMutations();
  const [filter, setFilter] = useState<RecurringFilter>("all");
  const query = useRecurringInfinite(filter);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Recurring | null>(null);

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => (page.ok ? page.data.items : [])) ?? [],
    [query.data],
  );

  function runNow() {
    run.mutate(undefined, {
      onSuccess: (res) => {
        if (res.ok) {
          toast(res.data.created > 0 ? runToastText(res.data.created, lang) : w(lang, "rRunZero"));
        } else {
          toast(res.detail || w(lang, "rErrRun"));
        }
      },
      onError: () => toast(w(lang, "rErrRun")),
    });
  }

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{w(lang, "rTitle")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{w(lang, "rSub")}</p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented<RecurringFilter>
          label={w(lang, "rTitle")}
          value={filter}
          onChange={setFilter}
          options={(Object.keys(FILTER_KEY) as RecurringFilter[]).map((f) => ({
            value: f,
            label: w(lang, FILTER_KEY[f]),
          }))}
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={runNow}
          disabled={run.isPending}
          className="flex items-center gap-1.5 rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
        >
          <IconPlay className="h-4 w-4" />
          {run.isPending ? w(lang, "rRunning") : w(lang, "rRunNow")}
        </button>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-control bg-emerald px-3.5 py-2.5 text-sm font-bold text-accent-ink hover:brightness-110"
        >
          <IconPlus className="h-4 w-4" />
          {w(lang, "rAddBtn")}
        </button>
      </div>

      {query.isPending && (
        <p className="mt-5 text-sm text-muted" role="status">
          {w(lang, "loading")}
        </p>
      )}
      {query.isError && (
        <div
          className="mt-5 rounded-card border border-danger bg-danger/5 p-4 text-sm font-medium text-danger"
          role="alert"
        >
          {w(lang, "rErrLoad")}
        </div>
      )}

      {!query.isPending && rows.length === 0 && (
        <div className="mt-5 rounded-card border border-line bg-surface p-8 text-center shadow-card">
          <p className="font-bold">
            {filter === "all" ? w(lang, "rEmpty") : w(lang, "emptyFiltered")}
          </p>
          {filter === "all" && <p className="mt-1 text-sm text-muted">{w(lang, "rEmptyHint")}</p>}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <p className="mt-3 px-1 text-[13px] text-muted">
            {lang === "bn"
              ? `${toBnDigits(String(rows.length))} ${w(lang, "entries")}`
              : `${rows.length} ${w(lang, "entries")}`}
          </p>
          <ul className="mt-2 flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
            {rows.map((rule) => (
              <RuleRow key={rule.id} rule={rule} onEdit={setEditing} />
            ))}
          </ul>
        </>
      )}

      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="rounded-control border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-60"
          >
            {query.isFetchingNextPage ? w(lang, "loading") : w(lang, "loadMore")}
          </button>
        </div>
      )}

      {(adding || editing) && (
        <RuleFormModal rule={editing} onClose={() => { setAdding(false); setEditing(null); }} />
      )}
    </section>
  );
}
