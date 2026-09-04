/**
 * Daily Hisab — shared API types (mirror of FastAPI schemas; ADR-0004).
 * Field names intentionally mirror DB columns (cat/grp/amt/pay/desc/iso) — see ADR-0004.
 */

import type { Lang } from "./i18n";
import type { Money } from "./money";

/** API error envelope — every non-2xx returns this shape. */
export interface ApiError {
  code: string;
  message_bn: string;
  message_en: string;
}

export type ExpenseGroup =
  | "food"
  | "housing"
  | "utility"
  | "transport"
  | "health"
  | "education"
  | "personal"
  | "other";

export type PayMethod = "cash" | "bkash" | "nagad" | "rocket" | "card" | "bank";

export interface Profile {
  id: string;
  name: string;
  email: string | null;
  lang: Lang;
  theme: "light" | "dark";
  created_at: string;
}

export interface Expense {
  id: string;
  user_id: string;
  cat: string;
  grp: ExpenseGroup;
  amt: Money;
  pay: PayMethod;
  desc: string | null;
  iso: string; // YYYY-MM-DD
  created_at: string;
}

export interface ExpenseCreate {
  cat: string;
  grp: ExpenseGroup;
  amt: Money;
  pay?: PayMethod;
  desc?: string | null;
  iso: string;
}

export type DebtDir = "lend" | "borrow";

export interface Debt {
  id: string;
  user_id: string;
  party: string;
  dir: DebtDir;
  amt: Money;
  note: string | null;
  iso: string;
  settled_at: string | null;
  created_at: string;
}

export interface DebtCreate {
  party: string;
  dir: DebtDir;
  amt: Money;
  note?: string | null;
  iso?: string;
}

export interface Budget {
  user_id: string;
  total: Money;
  cats: Record<string, number>;
  updated_at: string;
}

export interface BudgetPut {
  total: Money;
  cats?: Record<string, number>;
}

export interface Healthz {
  status: "ok";
  version: string;
  env: string;
}
