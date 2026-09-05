/**
 * Voice entry (T15.2) — thin, Expo-Go-safe wrapper around
 * expo-speech-recognition (github.com/jamsch/expo-speech-recognition).
 *
 * KEY CONSTRAINT (package README): speech-to-text requires a development
 * build (config plugin + mic/speech permissions) and will NEVER run in Expo
 * Go. Therefore the native module is resolved through a DYNAMIC import()
 * inside try/catch — never a static import — so bundling the package is safe
 * everywhere: in Expo Go the import itself throws and callers get `null`,
 * degrade to a visible bn/en hint chip (strings key `voiceUnavailable`) and
 * the manual add flow stays completely unaffected.
 *
 * The structural types below intentionally mirror only the slice of the
 * package API we use, so this file compiles without importing its .d.ts.
 */

/** One transcription alternative from a `result` event. */
interface VoiceResultAlternative {
  transcript: string;
  confidence: number;
}

/** `result` event — partial while speaking, final once `isFinal` is true. */
interface VoiceResultEvent {
  isFinal: boolean;
  results: VoiceResultAlternative[];
}

/** `error` event — e.g. "not-allowed", "no-speech", "service-not-allowed". */
interface VoiceErrorEvent {
  error: string;
  message?: string;
}

interface VoiceSubscription {
  remove(): void;
}

/** Minimal shape of `ExpoSpeechRecognitionModule` used here. */
interface SpeechRecognitionModule {
  start(options: {
    lang: string;
    interimResults: boolean;
    maxAlternatives: number;
    continuous: boolean;
    requiresOnDeviceRecognition: boolean;
    addsPunctuation: boolean;
    contextualStrings?: string[];
  }): void;
  stop(): void;
  abort(): void;
  addListener(
    eventName: "result",
    listener: (event: VoiceResultEvent) => void,
  ): VoiceSubscription;
  addListener(
    eventName: "error",
    listener: (event: VoiceErrorEvent) => void,
  ): VoiceSubscription;
  addListener(eventName: "end", listener: () => void): VoiceSubscription;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
}

/** Terminal callbacks; exactly one of onFinal/onError fires per session. */
export interface VoiceSessionHandlers {
  /** Live (interim) transcript while the user is speaking. */
  onPartial?(transcript: string): void;
  /** Completed transcript — fires once, after stop() or auto-detect. */
  onFinal(transcript: string): void;
  /** Recognizer failed or was denied permission. */
  onError?(code: string): void;
}

/** Handle for the caller to end (stop) or cancel (abort) a held session. */
export interface VoiceSession {
  stop(): void;
  abort(): void;
}

/** Permission codes the UI should map to the friendlier mic-permission hint. */
export const VOICE_PERMISSION_ERRORS: ReadonlySet<string> = new Set([
  "not-allowed",
  "service-not-allowed",
  "permission-denied",
  "microphone-permission-denied",
]);

let cachedModule: SpeechRecognitionModule | null | undefined;

/**
 * Resolve the native module once. Returns null in Expo Go / on web / on any
 * build that shipped without the native plugin — never throws.
 */
export async function loadSpeechModule(): Promise<SpeechRecognitionModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // DYNAMIC import on purpose (see file header). In Expo Go the module's
    // top-level requireNativeModule(...) throws → caught → null.
    const mod: unknown = await import("expo-speech-recognition");
    const candidate = mod as {
      ExpoSpeechRecognitionModule?: SpeechRecognitionModule;
    } | null;
    cachedModule = candidate?.ExpoSpeechRecognitionModule ?? null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True when this build can do STT at all (false in Expo Go). */
export async function isVoiceAvailable(): Promise<boolean> {
  return (await loadSpeechModule()) !== null;
}

/**
 * Start a bn-BD recognition session (hold-to-record on the add screen).
 * Resolves to a VoiceSession, or null when the module is missing or mic
 * permission was denied (callers show the availability chip / hint instead).
 *
 * Exactly one terminal callback fires: onFinal(transcript) or onError(code).
 * The session auto-unsubscribes its listeners after the terminal event.
 */
export async function startVoiceSession(
  lang: string,
  handlers: VoiceSessionHandlers,
): Promise<VoiceSession | null> {
  const module = await loadSpeechModule();
  if (module === null) {
    handlers.onError?.("module-unavailable");
    return null;
  }

  // Mic (+ iOS speech) permission — prompts when not granted yet.
  try {
    const perm = await module.requestPermissionsAsync();
    if (!perm.granted) {
      handlers.onError?.("not-allowed");
      return null;
    }
  } catch {
    // Permission API unavailable → let start() surface the real error below.
  }

  const subscriptions: VoiceSubscription[] = [];
  let finished = false;
  const cleanup = () => {
    for (const sub of subscriptions.splice(0)) {
      try {
        sub.remove();
      } catch {
        // Listener already gone — nothing to do.
      }
    }
  };
  const finish = (terminal: () => void) => {
    if (finished) return;
    finished = true;
    cleanup();
    terminal();
  };

  subscriptions.push(
    module.addListener("result", (event) => {
      const transcript = event.results?.[0]?.transcript ?? "";
      if (transcript.trim().length === 0) return;
      if (event.isFinal) {
        finish(() => handlers.onFinal(transcript.trim()));
      } else {
        handlers.onPartial?.(transcript);
      }
    }),
  );
  subscriptions.push(
    module.addListener("error", (event) => {
      finish(() => handlers.onError?.(event.error ?? "unknown"));
    }),
  );
  subscriptions.push(
    module.addListener("end", () => {
      // Ended with no final transcript (released too early / silence).
      finish(() => handlers.onError?.("no-speech"));
    }),
  );

  try {
    module.start({
      lang,
      interimResults: true,
      maxAlternatives: 1,
      continuous: false,
      requiresOnDeviceRecognition: false,
      addsPunctuation: false,
      contextualStrings: ["টাকা", "চা", "রিকশা", "বাজার", "ভাড়া"],
    });
  } catch {
    cleanup();
    handlers.onError?.("start-failed");
    return null;
  }

  return {
    stop: () => {
      try {
        module.stop();
      } catch {
        finish(() => handlers.onError?.("stop-failed"));
      }
    },
    abort: () => {
      try {
        module.abort();
      } catch {
        // Already inactive — nothing to do.
      }
    },
  };
}
