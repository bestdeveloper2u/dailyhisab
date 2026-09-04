import type { Lang } from "@khoroch/core";

/**
 * Local bn/en strings for the auth screens — keys that do not (yet) exist in
 * @khoroch/core's DICT. Kept beside the screens; promoting into core later
 * is mechanical. Both dicts must keep identical keys.
 */
export const L = {
  bn: {
    name: "নাম",
    namePlaceholder: "আপনার নাম",
    registerQ: "নতুন অ্যাকাউন্ট? রেজিস্টার করুন",
    registerBtn: "অ্যাকাউন্ট খুলুন",
    backToLoginQ: "অ্যাকাউন্ট আছে? লগইন করুন",
    pending: "একটু অপেক্ষা করুন…",
    errFallback: "সমস্যা হয়েছে — আবার চেষ্টা করুন",
  },
  en: {
    name: "Name",
    namePlaceholder: "Your name",
    registerQ: "New here? Create an account",
    registerBtn: "Create account",
    backToLoginQ: "Have an account? Log in",
    pending: "Please wait…",
    errFallback: "Something went wrong — please try again",
  },
} as const;

export type LocalKey = keyof typeof L.bn;

export const l = (lang: Lang, key: LocalKey): string => L[lang][key];
