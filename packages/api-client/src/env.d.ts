/**
 * Ambient typing for `import.meta.env` in this package. We only need
 * VITE_API_URL (vite/client types are not available inside packages/).
 */
interface ImportMetaEnv {
  /** Base URL of the API. Empty in dev — the vite proxy serves /api → :8000. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
