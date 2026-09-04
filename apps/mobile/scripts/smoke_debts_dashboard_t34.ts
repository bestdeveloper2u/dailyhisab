/**
 * T3.4 contract smoke — exercises the REAL hand-rolled mobile client
 * (lib/api.ts) against a live API server: the new Dashboard surface
 * (GET /api/v1/reports/monthly + GET /api/v1/expenses) and the Debts
 * surface (GET/POST /api/v1/debts + POST /api/v1/debts/{id}/pay).
 *
 * Setup (one terminal):
 *   cd apps/api
 *   KHOROCH_ENV=local \
 *   KHOROCH_DATABASE_URL=sqlite+aiosqlite:////tmp/khoroch_smoke_t34.db \
 *   KHOROCH_AUTH_RATE_LIMIT=10000 \
 *   uv run alembic upgrade head
 *   KHOROCH_ENV=local \
 *   KHOROCH_DATABASE_URL=sqlite+aiosqlite:////tmp/khoroch_smoke_t34.db \
 *   KHOROCH_AUTH_RATE_LIMIT=10000 \
 *   uv run python scripts/seed_demo.py
 *   KHOROCH_ENV=local \
 *   KHOROCH_DATABASE_URL=sqlite+aiosqlite:////tmp/khoroch_smoke_t34.db \
 *   KHOROCH_AUTH_RATE_LIMIT=10000 \
 *   uv run uvicorn app.main:app --port 8017
 *
 * Compile + run (another terminal):
 *   cd apps/mobile
 *   ./node_modules/.bin/tsc scripts/smoke_debts_dashboard_t34.ts lib/api.ts \
 *     --module commonjs --target es2022 --moduleResolution node \
 *     --lib es2022,dom --strict --esModuleInterop --skipLibCheck \
 *     --outDir /tmp/khoroch-mobile-smoke-t34
 *   EXPO_PUBLIC_API_URL=http://127.0.0.1:8017 \
 *     node /tmp/khoroch-mobile-smoke-t34/scripts/smoke_debts_dashboard_t34.js
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
  createDebt,
  createExpense,
  listDebts,
  listExpenses,
  login,
  monthlyReport,
  payDebt,
  register,
  type Debt,
} from "../lib/api";

const BASE = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8017";

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

/** Wire-contract assertions on one DebtOut row (ADR-0004 §1–§6). */
function checkDebtShape(label: string, row: Debt): boolean {
  const keys = Object.keys(row).sort().join(",");
  const wantKeys =
    "amt,created_at,dir,id,iso,note,party,settled_at,user_id";
  const ok =
    keys === wantKeys &&
    typeof row.id === "string" &&
    row.id.length === 36 &&
    row.user_id.length === 36 &&
    typeof row.party === "string" &&
    row.party.length > 0 &&
    (row.dir === "lend" || row.dir === "borrow") &&
    typeof row.amt === "string" && // money is a decimal STRING, never a number
    /^\d{1,10}\.\d{2}$/.test(row.amt) &&
    (row.note === null || typeof row.note === "string") &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.iso) &&
    row.created_at.endsWith("Z") && // RFC 3339 UTC
    (row.settled_at === null || row.settled_at.endsWith("Z"));
  check(label, ok, `keys=${keys} amt=${row.amt} iso=${row.iso}`);
  return ok;
}

/** Current month as "YYYY-MM" (UTC) — the API's ?ym= domain. */
function currentYm(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Today as "YYYY-MM-DD" (UTC). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** First day of the current month as "YYYY-MM-DD". */
function monthStartIso(): string {
  return `${currentYm()}-01`;
}

async function main(): Promise<void> {
  console.log(`Contract smoke T3.4 → ${BASE}`);
  const stamp = Date.now();
  const email = `mobile-smoke-t34-${stamp}@khoroch.app`;
  const password = "smoke-password-1";

  // --- Dashboard surface -----------------------------------------------------

  // 1) register a fresh user → auth pair.
  const pair = await register({ email, password, name: "T34 Smoke" });
  check(
    "register new user → 201 pair",
    typeof pair.accessToken === "string" && pair.user.email === email,
    pair.user.email,
  );
  const token = pair.accessToken;

  // 2) monthly report for a fresh account → zeroed, correctly shaped.
  const ym = currentYm();
  const emptyReport = await monthlyReport(token, ym);
  check(
    "fresh monthly report → {ym, total:'0.00', count:0, by_group:{}, by_day:[]}",
    emptyReport.ym === ym &&
      emptyReport.total === "0.00" &&
      emptyReport.count === 0 &&
      typeof emptyReport.by_group === "object" &&
      Object.keys(emptyReport.by_group).length === 0 &&
      Array.isArray(emptyReport.by_day) &&
      emptyReport.by_day.length === 0,
    `ym=${emptyReport.ym} total=${emptyReport.total}`,
  );

  // 3) add an expense for this month → report reflects it (total is a STRING).
  const spent = await createExpense(token, {
    cat: "চা",
    grp: "food",
    amt: "123.45",
    iso: todayIso(),
  });
  const afterOne = await monthlyReport(token, ym);
  check(
    "monthly report after 1 expense → total='123.45', by_group.food='123.45'",
    afterOne.total === "123.45" &&
      afterOne.count === 1 &&
      afterOne.by_group.food === "123.45",
    `total=${afterOne.total} by_group=${JSON.stringify(afterOne.by_group)}`,
  );

  // 4) default ?ym= (omitted) equals the explicit current month.
  const defaultReport = await monthlyReport(token);
  check(
    "monthly report default ym → same as explicit current month",
    defaultReport.ym === ym && defaultReport.total === "123.45",
  );

  // 5) 400 invalid_ym on a junk month (domain triple form).
  try {
    await monthlyReport(token, "2026-13");
    expectApiError("ym=2026-13 → ApiError 400", null as never, 400);
  } catch (err) {
    expectApiError(
      "ym=2026-13 → ApiError 400 + code=invalid_ym",
      err,
      400,
      "invalid_ym",
    );
  }

  // 6) recent expenses for the dashboard: first page, newest first.
  const recent = await listExpenses(token, { limit: 5 });
  check(
    "recent expenses (limit 5) → 1 row, matches the created expense",
    recent.items.length === 1 && recent.items[0].id === spent.id,
  );

  // --- Debts surface ----------------------------------------------------------

  // 7) create lend with default iso → today; settled_at + note null.
  const lend = await createDebt(token, {
    party: "রফিক",
    dir: "lend",
    amt: "2000.00",
  });
  checkDebtShape("create lend row shape (ADR-0004)", lend);
  check(
    "create lend defaults → iso=today, note=null, settled_at=null",
    lend.iso === todayIso() &&
      lend.note === null &&
      lend.settled_at === null &&
      lend.amt === "2000.00",
  );

  // 8) create borrow with explicit iso + note.
  const borrow = await createDebt(token, {
    party: "করিম চাচা",
    dir: "borrow",
    amt: "5000.00",
    iso: monthStartIso(),
    note: "বাসা ভাড়ার অগ্রিম",
  });
  checkDebtShape("create borrow row shape (ADR-0004)", borrow);
  check(
    "create borrow echoes iso + note",
    borrow.iso === monthStartIso() && borrow.note === "বাসা ভাড়ার অগ্রিম",
  );

  // 9) default list (status=open) → both rows, newest iso first.
  const openList = await listDebts(token);
  check(
    "list open → 2 rows, iso DESC",
    openList.items.length === 2 &&
      openList.items[0].id === lend.id && // iso today > month start
      openList.items[1].id === borrow.id &&
      openList.next_cursor === null,
    openList.items.map((d) => d.iso).join(" < "),
  );

  // 10) keyset pagination via next_cursor.
  const p1 = await listDebts(token, { status: "all", limit: 1 });
  check(
    "page 1 (limit=1) → 1 row + string cursor",
    p1.items.length === 1 && typeof p1.next_cursor === "string",
  );
  const p2 = await listDebts(token, {
    status: "all",
    limit: 5,
    cursor: p1.next_cursor ?? "",
  });
  check(
    "page 2 (cursor) → remaining row + null cursor",
    p2.items.length === 1 && p2.items[0].id === borrow.id && p2.next_cursor === null,
  );

  // 11) status filters.
  const settledList = await listDebts(token, { status: "settled" });
  check(
    "status=settled → 0 rows before any payment",
    settledList.items.length === 0 && settledList.next_cursor === null,
  );

  // 12) PARTIAL pay: 500.00 off the 2000.00 lend → remaining 1500.00.
  const partial = await payDebt(token, lend.id, "500.00");
  check(
    "pay 500.00 → PARTIAL, debt.amt='1500.00', still open",
    partial.status === "PARTIAL" &&
      partial.debt.amt === "1500.00" &&
      partial.debt.settled_at === null,
    `status=${partial.status} amt=${partial.debt.amt}`,
  );

  // 13) FULL pay: >= remaining settles; stored amt untouched; settled_at set.
  const full = await payDebt(token, lend.id, "1500.00");
  check(
    "pay 1500.00 → FULL, settled_at RFC3339Z, amt untouched",
    full.status === "FULL" &&
      full.debt.amt === "1500.00" &&
      full.debt.settled_at !== null &&
      full.debt.settled_at.endsWith("Z"),
    `status=${full.status} settled_at=${String(full.debt.settled_at)}`,
  );

  // 14) paying a settled debt → 409 debt_already_settled.
  try {
    await payDebt(token, lend.id, "10.00");
    expectApiError("pay settled → ApiError 409", null as never, 409);
  } catch (err) {
    expectApiError(
      "pay settled → ApiError 409 + code=debt_already_settled",
      err,
      409,
      "debt_already_settled",
    );
  }

  // 15) the settled debt moved to ?status=settled (and out of open).
  const settledAfter = await listDebts(token, { status: "settled" });
  const openAfter = await listDebts(token, { status: "open" });
  check(
    "filters after settle → settled has lend, open has only borrow",
    settledAfter.items.length === 1 &&
      settledAfter.items[0].id === lend.id &&
      openAfter.items.length === 1 &&
      openAfter.items[0].id === borrow.id,
  );

  // 16) 404 not_found on an unknown (random uuid) debt.
  try {
    await payDebt(token, "00000000-0000-4000-8000-000000000000", "10.00");
    expectApiError("pay unknown id → ApiError 404", null as never, 404);
  } catch (err) {
    expectApiError("pay unknown id → ApiError 404 + code=not_found", err, 404, "not_found");
  }

  // 17) 400 invalid_cursor on a garbage cursor.
  try {
    await listDebts(token, { cursor: "%%%garbage%%%" });
    expectApiError("garbage cursor → ApiError 400", null as never, 400);
  } catch (err) {
    expectApiError(
      "garbage cursor → ApiError 400 + code=invalid_cursor",
      err,
      400,
      "invalid_cursor",
    );
  }

  // 18) 422 on a money value violating ^\d{1,10}\.\d{2}$.
  try {
    await createDebt(token, { party: "ভাঙা", dir: "lend", amt: "12.345" });
    expectApiError("amt=12.345 → ApiError 422", null as never, 422);
  } catch (err) {
    expectApiError("amt=12.345 → ApiError 422", err, 422);
  }

  // 19) 401 on a bogus bearer (auth errors keep the plain-string detail form).
  try {
    await listDebts("not-a-real-token");
    expectApiError("bad bearer → ApiError 401", null as never, 401);
  } catch (err) {
    expectApiError("bad bearer → ApiError 401", err, 401, null);
  }

  // --- Demo user end-to-end (seeded data) -------------------------------------

  // 20) login as the seeded demo user → dashboard has real month data.
  const demo = await login("demo@khoroch.app", "demo1234");
  check(
    "demo login → 200 pair",
    demo.user.email === "demo@khoroch.app" &&
      typeof demo.accessToken === "string",
  );
  const demoReport = await monthlyReport(demo.accessToken, ym);
  check(
    "demo monthly report → total > 0, by_group non-empty, strings 2dp",
    Number(demoReport.total) > 0 &&
      Object.keys(demoReport.by_group).length > 0 &&
      /^\d+\.\d{2}$/.test(demoReport.total) &&
      Object.values(demoReport.by_group).every((v) => /^\d+\.\d{2}$/.test(v)),
    `total=${demoReport.total} groups=${Object.keys(demoReport.by_group).join(",")}`,
  );
  const demoRecent = await listExpenses(demo.accessToken, { limit: 5 });
  const demoDebts = await listDebts(demo.accessToken, { status: "open" });
  check(
    "demo recent expenses → 5 rows; demo open debts → seeded 3 rows",
    demoRecent.items.length === 5 &&
      demoDebts.items.length === 3 &&
      demoDebts.items.every((d) => d.settled_at === null),
    `recent=${demoRecent.items.length} open=${demoDebts.items.length}`,
  );

  console.log(
    failures === 0
      ? "SMOKE COMPLETE — 20/20 PASS"
      : `SMOKE FAILED — ${failures} FAIL`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("SMOKE CRASHED:", err);
  process.exit(1);
});
