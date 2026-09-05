/**
 * Daily Hisab — bn/en i18n.
 * Bengali-first UI; English full parity. Keys must exist in BOTH dicts (enforced by test).
 */

export type Lang = "bn" | "en";

export const DICT = {
  bn: {
    appName: "Daily Hisab",
    tagline: "দৈনিক খরচের হিসাব",
    navDashboard: "ড্যাশবোর্ড",
    navExpenses: "খরচ",
    navMonthly: "মাসিক হিসাব",
    navReport: "রিপোর্ট",
    navDebts: "ধার",
    navBudget: "বাজেট",
    navSettings: "সেটিংস",
    skipToContent: "সরাসরি মূল কন্টেন্টে যান",
    login: "লগইন",
    logout: "লগআউট",
    email: "ইমেইল",
    password: "পাসওয়ার্ড",
    loginBtn: "লগইন করুন",
    thisMonth: "এই মাসে",
    spent: "খরচ হয়েছে",
    budgetLeft: "বাজেটে বাকি",
    addExpense: "খরচ যোগ করুন",
    voiceHint: "যেমন: “মাছ ৮৯০ টাকা”",
    language: "ভাষা",
    comingSoon: "শীঘ্রই আসছে — নতুন অ্যাপে এই স্ক্রিন তৈরি হচ্ছে",
    savedCheck: "সংরক্ষিত ✓",
  },
  en: {
    appName: "Daily Hisab",
    tagline: "Daily expense tracking",
    navDashboard: "Dashboard",
    navExpenses: "Expenses",
    navMonthly: "Monthly",
    navReport: "Report",
    navDebts: "Debts",
    navBudget: "Budget",
    navSettings: "Settings",
    skipToContent: "Skip to main content",
    login: "Login",
    logout: "Logout",
    email: "Email",
    password: "Password",
    loginBtn: "Log in",
    thisMonth: "This month",
    spent: "Spent",
    budgetLeft: "Budget left",
    addExpense: "Add expense",
    voiceHint: "e.g. “mach 890 taka”",
    language: "Language",
    comingSoon: "Coming soon — this screen is being rebuilt in the new app",
    savedCheck: "Saved ✓",
  },
} as const;

export type DictKey = keyof typeof DICT.bn;

/** Translate a key. Falls back to Bengali if a key is ever missing. */
export function t(lang: Lang, key: DictKey): string {
  return DICT[lang][key] ?? DICT.bn[key];
}

export const isLang = (v: unknown): v is Lang => v === "bn" || v === "en";
