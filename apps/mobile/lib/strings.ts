/**
 * Mobile-only UI strings not (yet) in @khoroch/core's DICT.
 * Bengali-first defaults with English parity, mirroring core's i18n shape.
 * Promote to packages/core/src/i18n.ts when keys are needed cross-app.
 */
import type * as api from "./api";

export const STRINGS = {
  bn: {
    account: "অ্যাকাউন্ট",
    signingIn: "লগইন হচ্ছে…",
    errBadCreds: "ইমেইল বা পাসওয়ার্ড সঠিক নয়।",
    errNetwork: "সার্ভারে পৌঁছানো যাচ্ছে না — ইন্টারনেট সংযোগ দেখুন।",
    errGeneric: "কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।",

    // Expenses list (T3.1)
    expensesTitle: "খরচসমূহ",
    addExpenseBtn: "নতুন খরচ",
    loadingList: "খরচ লোড হচ্ছে…",
    emptyList: "এখনও কোনো খরচ নেই।",
    emptyListHint: "নিচের বাটন থেকে প্রথম খরচটি যোগ করুন।",
    loadMore: "আরও দেখুন",
    loadingMore: "আরও আনা হচ্ছে…",
    retry: "আবার চেষ্টা করুন",
    entriesLoaded: "টি এন্ট্রি দেখানো হচ্ছে",

    // Add expense form (T3.1)
    addTitle: "খরচ যোগ করুন",
    amount: "পরিমাণ (টাকা)",
    amountPlaceholder: "যেমন: 890",
    category: "খাত",
    categoryPlaceholder: "যেমন: চা, রিকশা, কাঁচাবাজার",
    groupLabel: "গ্রুপ",
    payLabel: "পেমেন্ট মাধ্যম",
    dateLabel: "তারিখ (YYYY-MM-DD)",
    descLabel: "বিবরণ (ঐচ্ছিক)",
    descPlaceholder: "যেমন: সপ্তাহের বাজার",
    save: "সংরক্ষণ করুন",
    saving: "সংরক্ষণ হচ্ছে…",
    errAmount: "সঠিক পরিমাণ লিখুন (০ এর বেশি)।",
    errCategory: "খাতের নাম লিখুন।",
    errDate: "তারিখ YYYY-MM-DD ফরম্যাটে দিন।",
    errUnauthorized: "সেশন শেষ হয়ে গেছে — আবার লগইন করুন।",
  },
  en: {
    account: "Account",
    signingIn: "Signing in…",
    errBadCreds: "Incorrect email or password.",
    errNetwork: "Cannot reach the server — check your connection.",
    errGeneric: "Something went wrong. Please try again.",

    // Expenses list (T3.1)
    expensesTitle: "Expenses",
    addExpenseBtn: "New expense",
    loadingList: "Loading expenses…",
    emptyList: "No expenses yet.",
    emptyListHint: "Add your first expense with the button below.",
    loadMore: "Load more",
    loadingMore: "Loading more…",
    retry: "Try again",
    entriesLoaded: "entries shown",

    // Add expense form (T3.1)
    addTitle: "Add expense",
    amount: "Amount (taka)",
    amountPlaceholder: "e.g. 890",
    category: "Category",
    categoryPlaceholder: "e.g. tea, rickshaw, groceries",
    groupLabel: "Group",
    payLabel: "Payment method",
    dateLabel: "Date (YYYY-MM-DD)",
    descLabel: "Description (optional)",
    descPlaceholder: "e.g. weekly groceries",
    save: "Save",
    saving: "Saving…",
    errAmount: "Enter a valid amount (greater than 0).",
    errCategory: "Enter a category name.",
    errDate: "Enter the date as YYYY-MM-DD.",
    errUnauthorized: "Session expired — please sign in again.",
  },
} as const;

export type MobileStringKey = keyof typeof STRINGS.bn;

/** Bengali labels for the API's 8 expense groups (grp column). */
export const GROUP_LABELS: Record<api.ExpenseGroup, string> = {
  food: "খাবার",
  housing: "বাসা",
  utility: "ইউটিলিটি",
  transport: "যাতায়াত",
  health: "স্বাস্থ্য",
  education: "শিক্ষা",
  personal: "ব্যক্তিগত",
  other: "অন্যান্য",
};

/** Bengali labels for the API's 6 payment methods (pay column). */
export const PAY_LABELS: Record<api.PayMethod, string> = {
  cash: "নগদ টাকা",
  bkash: "বিকাশ",
  nagad: "নগদ",
  rocket: "রকেট",
  card: "কার্ড",
  bank: "ব্যাংক",
};
