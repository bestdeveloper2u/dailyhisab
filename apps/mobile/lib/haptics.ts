/**
 * Haptics (T26.3) — thin, safe wrappers over expo-haptics.
 *
 * Contract: a missing haptics engine must NEVER break a user flow. On web
 * (Platform.OS === "web") every wrapper returns immediately — Expo web has
 * no haptics — and any native failure (Expo Go, unsupported device, engine
 * error) is swallowed and no-ops silently. Callers fire these and forget:
 * `void hapticSuccess();` — never awaited in a way that delays UX.
 */

import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

/** Run one haptics call unless we're on web; never throws. */
async function safeHaptic(play: () => Promise<void>): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    await play();
  } catch {
    // No haptics engine available (web build, Expo Go, unsupported device).
  }
}

/** Success notification haptic — add/save success. */
export async function hapticSuccess(): Promise<void> {
  await safeHaptic(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  );
}

/** Warning notification haptic — delete confirmations, save/validation errors. */
export async function hapticWarning(): Promise<void> {
  await safeHaptic(() =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  );
}

/** Light impact haptic — subtle confirmation taps. */
export async function hapticLight(): Promise<void> {
  await safeHaptic(() =>
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  );
}
