/**
 * T16.3 READ-ONLY live smoke — exercises the REAL hand-rolled mobile client
 * (lib/api.ts) recurring helpers against the live API:
 * https://mydailyhisab.vercel.app/api/v1
 *
 * WRITE POLICY (hard rule): strictly read-only except ONE throwaway register
 * account (sandboxed, named mobile-smoke-t16-*). NO POST/PATCH/DELETE hits
 * /api/v1/recurring with a valid token — run-now is only probed with a bogus
 * bearer, which the server rejects before any mutation could occur.
 *
 * The recurring endpoints (T16.1) may not be deployed yet: every check treats
 * ApiError 404 as "feature not live" and asserts the client surfaces a clean
 * ApiError (the screen's error state) instead of crashing — never a throw.
 *
 * Run:
 *   cd apps/mobile
 *   ./node_modules/.bin/tsc scripts/smoke_recurring_t16.ts lib/api.ts \
 *     --module commonjs --target es2022 --moduleResolution node \
 *     --lib es2022,dom --strict --esModuleInterop --skipLibCheck \
 *     --outDir /tmp/khoroch-mobile-smoke-t16
 *   EXPO_PUBLIC_API_URL=https://mydailyhisab.vercel.app \
 *     node /tmp/khoroch-mobile-smoke-t16/scripts/smoke_recurring_t16.js
 */

// Ambient Node env (kept local so the smoke compiles without @types/node).
declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

import {
  ApiError,
  listRecurring,
  login,
  register,
  runRecurring,
  type Recurring,
} from "../lib/api";

const BASE = process.env.EXPO_PUBLIC_API_URL ?? "https://mydailyhisab.vercel.app";

let failures = 0;

function check(label: string, ok: boolean, extra = ""): void {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${mark}] ${label}${extra ? ` — ${extra}` : ""}`);
}

/** Is this failure the expected "endpoints not deployed yet" 404? */
function isNotDeployed(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405);
}

function notDeployedNote(err: unknown): string {
  return `endpoint not live (ApiError ${String(
    err instanceof ApiError ? err.status : "?",
  )}) — graceful, screen shows error/empty state`;
}

/** T16.1 column sets (RecurringIn / RecurringOut verbatim). */
const GRPS = new Set([
  "food",
  "housing",
  "utility",
  "transport",
  "health",
  "education",
  "personal",
  "other",
]);
const PAYS = new Set(["cash", "bkash", "nagad", "rocket", "card", "bank"]);
const FREQS = new Set(["daily", "weekly", "monthly", "yearly"]);

/**
 * Wire-contract assertions on one RecurringOut row (T16.1 contract verbatim):
 * {id,user_id,cat,grp,amt,pay,desc,freq,start_date,next_run,active,
 *  created_at,updated_at} — snake_case, NO title/weekday/monthday/last_run.
 */
function checkRecurringShape(label: string, row: Recurring): boolean {
  const keys = Object.keys(row).sort().join(",");
  const wantKeys =
    "active,amt,cat,created_at,desc,freq,grp,id,next_run,pay,start_date,updated_at,user_id";
  const ok =
    keys === wantKeys &&
    typeof row.id === "string" &&
    row.id.length === 36 &&
    typeof row.user_id === "string" &&
    row.user_id.length === 36 &&
    typeof row.cat === "string" &&
    row.cat.length > 0 &&
    row.cat.length <= 80 &&
    GRPS.has(row.grp) &&
    typeof row.amt === "string" && // money is a decimal STRING, never a number
    /^\d{1,10}\.\d{2}$/.test(row.amt) &&
    PAYS.has(row.pay) &&
    (row.desc === null || typeof row.desc === "string") &&
    FREQS.has(row.freq) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.start_date) &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.next_run) &&
    typeof row.active === "boolean" &&
    row.created_at.endsWith("Z") && // RFC 3339 UTC
    row.updated_at.endsWith("Z");
  check(
    label,
    ok,
    `freq=${row.freq} grp=${row.grp} amt=${row.amt} next_run=${row.next_run} active=${String(row.active)}`,
  );
  return ok;
}

async function main(): Promise<void> {
  console.log(`Read-only live smoke T16.3 → ${BASE}`);

  // 1) Known-good demo login (read-only) → token for the recurring probes.
  const demo = await login("demo@khoroch.app", "demo1234");
  check(
    "demo login → 200 pair",
    demo.user.email === "demo@khoroch.app" &&
      typeof demo.accessToken === "string",
  );

  // 2) GET /recurring as demo → 200 keyset envelope (shape-checked) or 404.
  let live = false;
  try {
    const page = await listRecurring(demo.accessToken);
    live = true;
    const extraKeys = Object
      .keys(page)
      .filter((k) => k !== "items" && k !== "next_cursor");
    check(
      "demo GET /recurring → 200 {items, next_cursor} keyset envelope",
      Array.isArray(page.items) &&
        (page.next_cursor === null || typeof page.next_cursor === "string") &&
        extraKeys.length === 0,
      `items=${page.items.length} next_cursor=${
        page.next_cursor === null ? "null" : "set"
      } extraKeys=[${extraKeys.join(",")}]`,
    );
    for (const [i, row] of page.items.entries()) {
      checkRecurringShape(`demo recurring[${i}] shape (T16.1)`, row);
      if (i >= 4) break; // shape-check at most 5 rows
    }
  } catch (err) {
    if (isNotDeployed(err)) {
      check("demo GET /recurring → graceful when not deployed", true, notDeployedNote(err));
    } else {
      check(
        "demo GET /recurring → unexpected failure",
        false,
        err instanceof ApiError
          ? `ApiError ${err.status}: ${err.message.slice(0, 80)}`
          : String(err),
      );
    }
  }

  // 3) THROWAWAY register account (the only sanctioned write) → the screen's
  //    empty state: 200 {items: [], next_cursor: null} when live, or the same
  //    graceful 404.
  const stamp = Date.now();
  const fresh = await register({
    email: `mobile-smoke-t16-${stamp}@khoroch.app`,
    password: "smoke-password-1",
    name: "T16.3 Smoke",
  });
  check(
    "throwaway register → pair (sandboxed write #1 of 1)",
    typeof fresh.accessToken === "string",
  );
  try {
    const empty = await listRecurring(fresh.accessToken);
    live = true;
    check(
      "fresh account GET /recurring → 200 empty keyset page (screen empty state)",
      Array.isArray(empty.items) &&
        empty.items.length === 0 &&
        empty.next_cursor === null,
      `items=${empty.items.length} next_cursor=${String(empty.next_cursor)}`,
    );
  } catch (err) {
    if (isNotDeployed(err)) {
      check("fresh GET /recurring → graceful when not deployed", true, notDeployedNote(err));
    } else {
      check("fresh GET /recurring → unexpected failure", false, String(err));
    }
  }

  // 4) Bogus bearer GET → 401 (feature live) or 404 (not deployed) — either
  //    way the client must raise a typed ApiError, never crash the screen.
  try {
    await listRecurring("not-a-real-token");
    check("bad bearer GET /recurring → expected rejection, got 200", false);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || isNotDeployed(err))) {
      check(
        "bad bearer GET /recurring → typed ApiError (graceful)",
        true,
        `status=${err.status}${err.code !== null ? ` code=${err.code}` : ""}`,
      );
    } else {
      check("bad bearer GET /recurring → unexpected failure", false, String(err));
    }
  }

  // 5) Bogus bearer run-now → server rejects before any mutation; client must
  //    surface ApiError 401/404 (the screen's inline error), never crash.
  //    NO valid-token run here: that would create real expenses.
  try {
    await runRecurring("not-a-real-token");
    check("bad bearer POST /recurring/run → expected rejection, got 200", false);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || isNotDeployed(err))) {
      check(
        "bad bearer POST /recurring/run → typed ApiError (graceful, no writes)",
        true,
        `status=${err.status}${err.code !== null ? ` code=${err.code}` : ""}`,
      );
    } else {
      check("bad bearer POST /recurring/run → unexpected failure", false, String(err));
    }
  }

  console.log(
    `${failures === 0 ? "SMOKE COMPLETE" : "SMOKE FAILED"} — ${
      failures === 0 ? "all checks PASS" : `${failures} FAIL`
    }${live ? " (recurring endpoints LIVE)" : " (recurring endpoints not live — 404 pre-redeploy handled gracefully)"}`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("SMOKE CRASHED:", err);
  process.exit(1);
});
