/**
 * T3.1 contract smoke — exercises the REAL hand-rolled mobile client
 * (lib/api.ts) against a live API server (Track A, Phase 3). Throwaway
 * harness, mirroring apps/api/scripts/smoke_auth_cycle4.py from Phase 1.
 *
 * Setup (one terminal):
 *   cd apps/api
 *   KHOROCH_ENV=local \
 *   KHOROCH_DATABASE_URL=sqlite+aiosqlite:////tmp/khoroch_smoke_t31.db \
 *   KHOROCH_AUTH_RATE_LIMIT=100 \
 *   .venv/bin/alembic upgrade head
 *   KHOROCH_ENV=local \
 *   KHOROCH_DATABASE_URL=sqlite+aiosqlite:////tmp/khoroch_smoke_t31.db \
 *   KHOROCH_AUTH_RATE_LIMIT=100 \
 *   .venv/bin/python -m uvicorn app.main:app --port 8010
 *
 * Compile + run (another terminal):
 *   cd apps/mobile
 *   ./node_modules/.bin/tsc scripts/smoke_expenses_t31.ts lib/api.ts \
 *     --module commonjs --target es2022 --moduleResolution node \
 *     --lib es2022,dom --strict --esModuleInterop --skipLibCheck \
 *     --outDir /tmp/khoroch-mobile-smoke
 *   EXPO_PUBLIC_API_URL=http://127.0.0.1:8010 \
 *     node /tmp/khoroch-mobile-smoke/scripts/smoke_expenses_t31.js
 *
 * (lib/api.ts is import-free beyond fetch + process.env, so it runs on plain
 * Node — the same hand-rolled code the Expo app ships.)
 */

// Ambient Node env (kept local so the smoke compiles without @types/node).
declare const process: {
  env: Record<string, string | undefined>;
  exit(code: number): never;
};

import {
  ApiError,
  createExpense,
  listExpenses,
  register,
  type Expense,
} from "../lib/api";

const BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8010";

let failures = 0;

function check(label: string, ok: boolean, extra = ""): void {
  const mark = ok ? "PASS" : "FAIL";
  if (!ok) failures += 1;
  console.log(`[${mark}] ${label}${extra ? ` — ${extra}` : ""}`);
}

function expectApiError(
  label: string,
  err: unknown,
  wantStatus: number,
  wantCode?: string | null,
): void {
  if (!(err instanceof ApiError)) {
    check(label, false, `not an ApiError: ${String(err)}`);
    return;
  }
  let ok = err.status === wantStatus;
  let extra = `status=${err.status} (want ${wantStatus})`;
  if (ok && wantCode !== undefined) {
    ok = err.code === wantCode;
    extra += `, code=${String(err.code)} (want ${String(wantCode)})`;
  }
  if (ok) extra += `, msg="${err.message.slice(0, 60)}"`;
  check(label, ok, extra);
}

/** Wire-contract assertions on one ExpenseOut row (ADR-0004 §1–§6). */
function checkRowShape(label: string, row: Expense): boolean {
  const keys = Object.keys(row).sort().join(",");
  const wantKeys = "amt,cat,created_at,desc,grp,id,iso,pay,user_id";
  const ok =
    keys === wantKeys &&
    typeof row.id === "string" &&
    row.id.length === 36 &&
    row.user_id.length === 36 &&
    typeof row.amt === "string" && // money is a decimal STRING, never a number
    /^\d{1,10}\.\d{2}$/.test(row.amt) &&
    typeof row.cat === "string" &&
    row.cat.length > 0 &&
    typeof row.iso === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.iso) && // event date, not a currency code
    row.created_at.endsWith("Z") && // RFC 3339 UTC
    (row.desc === null || typeof row.desc === "string");
  check(label, ok, `keys=${keys} amt=${row.amt} iso=${row.iso}`);
  return ok;
}

async function main(): Promise<void> {
  console.log(`Contract smoke T3.1 → ${BASE}`);
  const stamp = Date.now();
  const email = `mobile-smoke-${stamp}@khoroch.app`;
  const password = "smoke-password-1";

  // 1) register a fresh user → auth pair (Phase-1 client still speaks API).
  const pair = await register({ email, password, name: "Mobile Smoke" });
  check(
    "register new user → 201 pair",
    typeof pair.accessToken === "string" &&
      typeof pair.refreshToken === "string" &&
      pair.user.email === email,
    pair.user.email,
  );
  const token = pair.accessToken;

  // 2) empty list for the fresh account.
  const empty = await listExpenses(token);
  check(
    "list fresh user → {items:[], next_cursor:null}",
    Array.isArray(empty.items) &&
      empty.items.length === 0 &&
      empty.next_cursor === null,
  );

  // 3) create #1 — defaults: pay=cash, desc=null.
  const one = await createExpense(token, {
    cat: "চা",
    grp: "food",
    amt: "123.45",
    iso: "2026-09-01",
  });
  checkRowShape("create #1 row shape (ADR-0004)", one);
  check(
    "create #1 defaults pay=cash, desc=null",
    one.pay === "cash" && one.desc === null,
    `pay=${one.pay} desc=${String(one.desc)}`,
  );

  // 4) create #2 + #3 (explicit pay/desc, different dates).
  const two = await createExpense(token, {
    cat: "রিকশা",
    grp: "transport",
    amt: "40.00",
    iso: "2026-09-03",
    pay: "bkash",
    desc: "অফিস যাওয়া",
  });
  const three = await createExpense(token, {
    cat: "বই",
    grp: "education",
    amt: "990.00",
    iso: "2026-09-02",
    pay: "card",
  });
  check(
    "create #2/#3 echo pay + desc",
    two.pay === "bkash" &&
      two.desc === "অফিস যাওয়া" &&
      three.amt === "990.00",
  );

  // 5) default list → newest first (iso DESC, id DESC).
  const page1 = await listExpenses(token);
  const orderOk =
    page1.items.length === 3 &&
    page1.items[0].id === two.id && // iso 2026-09-03 — newest date first
    page1.items[1].id === three.id &&
    page1.items[2].id === one.id;
  check(
    "list default → 3 rows, iso DESC then id DESC",
    orderOk,
    page1.items.map((r) => r.iso).join(" < "),
  );

  // 6) keyset pagination via next_cursor (ADR-0004 §8).
  const p1 = await listExpenses(token, { limit: 2 });
  check(
    "page 1 (limit=2) → 2 rows + string cursor",
    p1.items.length === 2 && typeof p1.next_cursor === "string",
  );
  const p2 = await listExpenses(token, {
    limit: 2,
    cursor: p1.next_cursor ?? "",
  });
  check(
    "page 2 (cursor) → last row + null cursor",
    p2.items.length === 1 &&
      p2.items[0].id === one.id &&
      p2.next_cursor === null,
  );

  // 7) filters ?q= and ?from=&to=.
  const q = await listExpenses(token, { q: "রিকশা" });
  check(
    "filter q=রিকশা → exactly the rickshaw row",
    q.items.length === 1 && q.items[0].id === two.id,
  );
  const windowed = await listExpenses(token, {
    from: "2026-09-02",
    to: "2026-09-03",
  });
  check(
    "filter from/to window → 2 rows",
    windowed.items.length === 2 &&
      windowed.items.every((r) => r.iso >= "2026-09-02" && r.iso <= "2026-09-03"),
  );

  // 8) 422 on a money value violating ^\d{1,10}\.\d{2}$.
  try {
    await createExpense(token, {
      cat: "ভাঙা",
      grp: "other",
      amt: "12.345",
      iso: "2026-09-01",
    });
    expectApiError("amt=12.345 → ApiError 422", null as never, 422);
  } catch (err) {
    expectApiError("amt=12.345 → ApiError 422", err, 422);
  }

  // 9) 401 on a bogus bearer (auth errors keep the plain-string detail form).
  try {
    await listExpenses("not-a-real-token");
    expectApiError("bad bearer → ApiError 401", null as never, 401);
  } catch (err) {
    expectApiError("bad bearer → ApiError 401", err, 401, null);
  }

  // 10) 400 invalid_cursor — exercises the {code,message_bn,message_en} triple.
  try {
    await listExpenses(token, { cursor: "%%%garbage%%%" });
    expectApiError("garbage cursor → ApiError 400", null as never, 400);
  } catch (err) {
    expectApiError(
      "garbage cursor → ApiError 400 + code=invalid_cursor",
      err,
      400,
      "invalid_cursor",
    );
  }

  console.log(failures === 0 ? "SMOKE COMPLETE — 10/10 PASS" : `SMOKE FAILED — ${failures} FAIL`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("SMOKE CRASHED:", err);
  process.exit(1);
});
