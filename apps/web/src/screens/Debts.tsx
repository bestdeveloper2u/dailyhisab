import { useMemo, useState } from "react";
import { moneyToNumber, t, toBnDigits } from "@khoroch/core";
import type { Debt } from "@khoroch/api-client";
import { useDebtMutations, useDebtsInfinite } from "../lib/queries";
import { dayLabel, normalizeAmount, todayIso } from "../lib/catalog";
import { w } from "../lib/web-i18n";
import { fmtTaka } from "../lib/money";
import { usePageTitle } from "../lib/usePageTitle";
import { useLangStore } from "../store/lang";
import { Modal } from "../components/Modal";
import { toast } from "../lib/toast";
import { IconTrash } from "../components/icons";

type StatusTab = "open" | "settled" | "all";
const STATUS_TABS: StatusTab[] = ["open", "settled", "all"];
const STATUS_KEY = { open: "dOpen", settled: "dSettledLbl", all: "dAll" } as const;

/** Two-step delete (arm → confirm), mirroring the expenses list. */
function DeleteDebtButton({ debt }: { debt: Debt }) {
  const lang = useLangStore((s) => s.lang);
  const { remove } = useDebtMutations();
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button
        type="button"
        aria-label={`${debt.party} — ${w(lang, "remove")}`}
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
          remove.mutate(debt.id, {
            onSuccess: () => {
              setArmed(false);
              toast(w(lang, "tDeleted"));
            },
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

/** Pay-back dialog: prefills the remaining amount, offers a full-amount shortcut. */
function PayModal({ debt, onClose }: { debt: Debt; onClose: () => void }) {
  const lang = useLangStore((s) => s.lang);
  const { pay } = useDebtMutations();
  const [amt, setAmt] = useState(moneyToNumber(debt.amt).toString());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const normalized = normalizeAmount(amt);
    if (!normalized || moneyToNumber(normalized) <= 0) {
      setError(w(lang, "errAmt"));
      return;
    }
    setError(null);
    pay.mutate(
      { id: debt.id, amt: normalized },
      {
        onSuccess: (res) => {
          if (res.ok) {
            // FULL settles the row; PARTIAL shrinks it — the list refetches.
            const message =
              res.data.status === "FULL"
                ? w(lang, "dPaidFull")
                : `${w(lang, "dPaidPartial")} ${fmtTaka(res.data.debt.amt, lang)}`;
            setFeedback(message);
            toast(message);
            setTimeout(() => onClose(), 900);
          } else {
            setError(res.detail || w(lang, "dErrPay"));
          }
        },
        onError: () => setError(w(lang, "dErrPay")),
      },
    );
  }

  return (
    <Modal open onClose={onClose} label={w(lang, "dPayTitle")}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div>
          <h2 className="text-lg font-bold">{w(lang, "dPayTitle")}</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {debt.party} · {fmtTaka(debt.amt, lang)}
          </p>
        </div>
        <div>
          <label htmlFor="payAmt" className="text-[13px] font-semibold text-muted">
            {w(lang, "dPayAmt")}
          </label>
          <input
            id="payAmt"
            type="text"
            inputMode="decimal"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
            className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-lg font-bold tabular-nums text-ink focus:border-emerald focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setAmt(moneyToNumber(debt.amt).toString())}
            className="mt-2 rounded-full border border-emerald bg-emerald-soft px-3 py-1 text-xs font-bold text-emerald hover:brightness-95"
          >
            {w(lang, "dPayFull")} — {fmtTaka(debt.amt, lang)}
          </button>
        </div>
        {error && (
          <p className="text-sm font-medium text-danger" role="alert">
            {error}
          </p>
        )}
        {feedback && (
          <p className="text-sm font-semibold text-emerald" role="status">
            {feedback}
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
            disabled={pay.isPending}
            className="rounded-control bg-emerald px-4 py-2.5 text-sm font-bold text-accent-ink hover:brightness-110 disabled:opacity-60"
          >
            {pay.isPending ? w(lang, "saving") : w(lang, "dPay")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One ledger row: avatar, party + note, lend/borrow badge, amount, actions. */
function DebtRow({ debt, onPay }: { debt: Debt; onPay: (debt: Debt) => void }) {
  const lang = useLangStore((s) => s.lang);
  const lend = debt.dir === "lend";
  const settled = debt.settled_at !== null;

  return (
    <li className="flex items-center gap-3 px-3.5 py-3">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-soft text-sm font-bold text-emerald"
      >
        {debt.party.slice(0, 1)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-semibold">
          {debt.party}
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
              lend ? "bg-emerald-soft text-emerald" : "bg-warning/10 text-warning"
            }`}
          >
            {lend ? w(lang, "dGave") : w(lang, "dTook")}
          </span>
          {settled && (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-bold text-muted">
              {w(lang, "dSettled")}
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted">
          {dayLabel(debt.iso, lang)}
          {debt.note ? ` · ${debt.note}` : ""}
        </p>
      </div>
      <span className={`text-sm font-bold tabular-nums ${lend ? "text-emerald" : "text-danger"}`}>
        {fmtTaka(debt.amt, lang)}
      </span>
      {!settled && (
        <button
          type="button"
          onClick={() => onPay(debt)}
          className="shrink-0 rounded-control border border-emerald px-2.5 py-1.5 text-xs font-bold text-emerald hover:bg-emerald-soft"
        >
          {w(lang, "dPay")}
        </button>
      )}
      <DeleteDebtButton debt={debt} />
    </li>
  );
}

/**
 * Debts screen (ধার-দেনা): receive/pay KPIs over the loaded rows, an
 * open/settled/all ledger with pay-back and delete, and a new-entry form —
 * all against the real /api/v1/debts endpoints.
 */
export function Debts() {
  usePageTitle("ধার · Daily Hisab");
  const lang = useLangStore((s) => s.lang);
  const { create } = useDebtMutations();
  const [status, setStatus] = useState<StatusTab>("open");
  const query = useDebtsInfinite(status);

  // New-entry form state (prototype: party, dir, amount, date, note).
  const [party, setParty] = useState("");
  const [dir, setDir] = useState<"lend" | "borrow">("lend");
  const [amt, setAmt] = useState("");
  const [iso, setIso] = useState(todayIso());
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const [payTarget, setPayTarget] = useState<Debt | null>(null);

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => (page.ok ? page.data.items : [])) ?? [],
    [query.data],
  );
  const totalIn = useMemo(
    () => rows.filter((d) => d.dir === "lend").reduce((s, d) => s + moneyToNumber(d.amt), 0),
    [rows],
  );
  const totalOut = useMemo(
    () => rows.filter((d) => d.dir === "borrow").reduce((s, d) => s + moneyToNumber(d.amt), 0),
    [rows],
  );

  function submitDebt() {
    const normalized = normalizeAmount(amt);
    if (!party.trim()) {
      setFormError(w(lang, "dErrParty"));
      return;
    }
    if (!normalized || moneyToNumber(normalized) <= 0) {
      setFormError(w(lang, "errAmt"));
      return;
    }
    setFormError(null);
    create.mutate(
      { party: party.trim().slice(0, 120), dir, amt: normalized, iso, note: note.trim() || null },
      {
        onSuccess: (res) => {
          if (res.ok) {
            setParty("");
            setAmt("");
            setNote("");
            setIso(todayIso());
            setSavedFlash(true);
            toast(t(lang, "savedCheck"));
            setTimeout(() => setSavedFlash(false), 2000);
          } else {
            setFormError(res.detail || w(lang, "dErrSave"));
          }
        },
        onError: () => setFormError(w(lang, "dErrSave")),
      },
    );
  }

  return (
    <section>
      <h1 className="text-[22px] font-bold sm:text-2xl">{w(lang, "dTitle")}</h1>
      <p className="mt-0.5 text-[13px] text-muted">{w(lang, "dSub")}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-card border border-line bg-surface p-5 shadow-card">
          <p className="text-[13px] font-medium text-muted">{w(lang, "dIn")}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-emerald">
            {fmtTaka(totalIn, lang)}
          </p>
        </div>
        <div className="rounded-card border border-line bg-surface p-5 shadow-card">
          <p className="text-[13px] font-medium text-muted">{w(lang, "dOut")}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-danger">
            {fmtTaka(totalOut, lang)}
          </p>
        </div>
      </div>

      <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "dLedger")}</h2>
      <div
        className="mt-2 inline-flex rounded-control bg-surface-2 p-1"
        role="group"
        aria-label={w(lang, "dLedger")}
      >
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-control px-4 py-1.5 text-[13px] font-bold ${
              status === s ? "bg-surface text-ink shadow-card" : "text-muted"
            }`}
          >
            {w(lang, STATUS_KEY[s])}
          </button>
        ))}
      </div>

      {savedFlash && (
        <p className="mt-3 text-sm font-semibold text-emerald" role="status">
          {t(lang, "savedCheck")}
        </p>
      )}
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
          {w(lang, "dErrLoad")}
        </div>
      )}

      {!query.isPending && rows.length === 0 && (
        <div className="mt-5 rounded-card border border-line bg-surface p-8 text-center shadow-card">
          <p className="font-bold">{w(lang, "dEmpty")}</p>
          <p className="mt-1 text-sm text-muted">{w(lang, "dEmptyHint")}</p>
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
            {rows.map((debt) => (
              <DebtRow key={debt.id} debt={debt} onPay={setPayTarget} />
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

      <h2 className="mt-6 px-1 text-[13px] font-bold text-muted">{w(lang, "dNew")}</h2>
      <form
        className="mt-2 max-w-[520px] rounded-card border border-line bg-surface p-5 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          submitDebt();
        }}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label htmlFor="debtParty" className="text-[13px] font-semibold text-muted">
              {w(lang, "dParty")}
            </label>
            <input
              id="debtParty"
              type="text"
              value={party}
              onChange={(e) => setParty(e.target.value)}
              placeholder={w(lang, "dPh")}
              maxLength={120}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="debtDir" className="text-[13px] font-semibold text-muted">
              {w(lang, "dType")}
            </label>
            <select
              id="debtDir"
              value={dir}
              onChange={(e) => setDir(e.target.value as "lend" | "borrow")}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-emerald focus:outline-none"
            >
              <option value="lend">{w(lang, "dLend")}</option>
              <option value="borrow">{w(lang, "dBorrow")}</option>
            </select>
          </div>
          <div>
            <label htmlFor="debtAmt" className="text-[13px] font-semibold text-muted">
              {w(lang, "amtLabel")}
            </label>
            <input
              id="debtAmt"
              type="text"
              inputMode="decimal"
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              placeholder={w(lang, "amtPh")}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-lg font-bold tabular-nums text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="debtDate" className="text-[13px] font-semibold text-muted">
              {w(lang, "dateLabel")}
            </label>
            <input
              id="debtDate"
              type="date"
              value={iso}
              onChange={(e) => setIso(e.target.value || todayIso())}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink focus:border-emerald focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="debtNote" className="text-[13px] font-semibold text-muted">
              {w(lang, "dNote")}
            </label>
            <input
              id="debtNote"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={w(lang, "dOpt")}
              maxLength={200}
              className="mt-1 w-full rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none"
            />
          </div>
          {formError && (
            <p className="text-sm font-medium text-danger" role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-control bg-emerald px-4 py-2.5 text-sm font-bold text-accent-ink hover:brightness-110 disabled:opacity-60"
          >
            {create.isPending ? w(lang, "saving") : w(lang, "save")}
          </button>
        </div>
      </form>

      {payTarget && <PayModal debt={payTarget} onClose={() => setPayTarget(null)} />}
    </section>
  );
}
