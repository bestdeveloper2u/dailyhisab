import { useState, type FormEvent } from "react";
import { t } from "@khoroch/core";
import type { Expense, ExpenseGroup, PayMethod } from "@khoroch/api-client";
import { useExpenseMutations } from "../lib/queries";
import {
  BUMP_STEPS,
  GROUP_LABELS,
  GROUP_ORDER,
  PAY_LABELS,
  bumpAmount,
  normalizeAmount,
  todayIso,
} from "../lib/catalog";
import { w } from "../lib/web-i18n";
import { useLangStore } from "../store/lang";
import { toast } from "../lib/toast";
import { Modal } from "./Modal";

const inputClass =
  "w-full rounded-control border border-line bg-ivory px-3.5 py-2.5 text-sm text-ink placeholder:text-muted/70 focus:border-emerald focus:outline-none";

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

  const pending = create.isPending || update.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const amtStr = normalizeAmount(amt);
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
      const res = await create.mutateAsync({
        amt: amtStr,
        cat: catTrimmed,
        grp,
        pay,
        iso,
        desc: desc.trim() || null,
      });
      if (res.ok) {
        setAmt("");
        setCat("");
        setDesc("");
        toast(t(lang, "savedCheck"));
        onClose();
        return;
      }
      setError(res.detail || w(lang, "errFallback"));
    }
  }

  return (
    <Modal open={open} onClose={onClose} label={w(lang, expense ? "editTitle" : "addTitle")}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5" aria-busy={pending}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold">{w(lang, expense ? "editTitle" : "addTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
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
                onClick={() => setAmt(bumpAmount(amt, step.add))}
                className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-emerald hover:text-emerald"
              >
                {w(lang, step.key)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
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
              onChange={(e) => setCat(e.target.value)}
              placeholder={w(lang, "catPh")}
              className={inputClass}
            />
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
          {pending ? w(lang, "saving") : w(lang, "save")}
        </button>
      </form>
    </Modal>
  );
}
