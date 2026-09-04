/**
 * Mobile-only UI strings not (yet) in @khoroch/core's DICT.
 * Bengali-first defaults with English parity, mirroring core's i18n shape.
 * Promote to packages/core/src/i18n.ts when keys are needed cross-app.
 */
export const STRINGS = {
  bn: {
    account: "অ্যাকাউন্ট",
    signingIn: "লগইন হচ্ছে…",
    errBadCreds: "ইমেইল বা পাসওয়ার্ড সঠিক নয়।",
    errNetwork: "সার্ভারে পৌঁছানো যাচ্ছে না — ইন্টারনেট সংযোগ দেখুন।",
    errGeneric: "কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।",
  },
  en: {
    account: "Account",
    signingIn: "Signing in…",
    errBadCreds: "Incorrect email or password.",
    errNetwork: "Cannot reach the server — check your connection.",
    errGeneric: "Something went wrong. Please try again.",
  },
} as const;

export type MobileStringKey = keyof typeof STRINGS.bn;
