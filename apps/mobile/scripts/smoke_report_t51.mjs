/**
 * T5.1 live contract smoke — monthly/yearly reports (mobile consumption).
 * Plain node (>=18, global fetch). Run: node scripts/smoke_report_t51.mjs
 *
 * Creates a THROWAWAY user, seeds 3 expenses in the current month, then
 * asserts the report endpoints return matching decimal-string totals and a
 * 12-entry zero-filled by_month. Never touches existing/demo data.
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8000";

const now = new Date();
const YYYY = now.getUTCFullYear();
const MM = String(now.getUTCMonth() + 1).padStart(2, "0");
const YM = `${YYYY}-${MM}`;
const TODAY = `${YM}-${String(now.getUTCDate()).padStart(2, "0")}`;

const email = `smoke+${Date.now()}@test.local`;
const password = "Test1234!";

let failures = 0;
function assert(cond, label, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${mark}] ${label}${extra !== "" ? ` — ${extra}` : ""}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// Seed plan: 2 rows in "food" + 1 in "transport" → total 400.50 in current month.
const SEED = [
  { cat: "চা", grp: "food", amt: "250.50" },
  { cat: "রিকশা", grp: "transport", amt: "120.00" },
  { cat: "কাঁচাবাজার", grp: "food", amt: "30.00" },
];
const EXPECT_TOTAL = "400.50";

console.log(`smoke_report_t51 — base=${BASE} ym=${YM}`);
console.log(`1) POST /api/v1/auth/register (${email})`);
const reg = await call("POST", "/api/v1/auth/register", {
  body: { email, password, name: "T5.1 Smoke" },
});
assert(reg.status === 201, "register → 201", `got ${reg.status}`);
const access = reg.json?.accessToken;
assert(typeof access === "string" && access.length > 0, "register → accessToken present");

console.log(`2) POST /api/v1/expenses × ${SEED.length}`);
const createdIds = [];
for (const item of SEED) {
  const made = await call("POST", "/api/v1/expenses", {
    token: access,
    body: { ...item, iso: TODAY, pay: "cash", desc: null },
  });
  assert(made.status === 201, `create expense ${item.cat} ${item.amt} → 201`, `got ${made.status}`);
  if (made.json?.id !== undefined) createdIds.push(made.json.id);
}
assert(createdIds.length === SEED.length, "all seeded expense ids returned");

console.log(`3) GET /api/v1/reports/monthly?ym=${YM}`);
const month = await call("GET", `/api/v1/reports/monthly?ym=${YM}`, { token: access });
assert(month.status === 200, "monthly → 200", `got ${month.status}`);
assert(month.json?.ym === YM, "monthly.ym === current ym", `got ${month.json?.ym}`);
assert(
  month.json?.total === EXPECT_TOTAL,
  "monthly.total === \"400.50\" (decimal-string compare)",
  `got ${JSON.stringify(month.json?.total)}`,
);
assert(month.json?.count === SEED.length, `monthly.count === ${SEED.length}`, `got ${month.json?.count}`);
assert(
  month.json?.by_group?.food === "280.50",
  "monthly.by_group.food === \"280.50\"",
  `got ${JSON.stringify(month.json?.by_group?.food)}`,
);
assert(
  month.json?.by_group?.transport === "120.00",
  "monthly.by_group.transport === \"120.00\"",
  `got ${JSON.stringify(month.json?.by_group?.transport)}`,
);
assert(month.json?.by_day?.at(-1)?.iso === TODAY, "monthly.by_day last entry is today");

console.log(`4) GET /api/v1/reports/yearly?year=${YYYY}`);
const year = await call("GET", `/api/v1/reports/yearly?year=${YYYY}`, { token: access });
assert(year.status === 200, "yearly → 200", `got ${year.status}`);
assert(year.json?.year === YYYY, "yearly.year === current year", `got ${year.json?.year}`);
assert(
  year.json?.total === EXPECT_TOTAL,
  "yearly.total === \"400.50\" (decimal-string compare)",
  `got ${JSON.stringify(year.json?.total)}`,
);
assert(year.json?.count === SEED.length, `yearly.count === ${SEED.length}`, `got ${year.json?.count}`);
assert(
  Array.isArray(year.json?.by_month) && year.json.by_month.length === 12,
  "yearly.by_month has 12 entries",
  `got ${year.json?.by_month?.length}`,
);
const byMonth = year.json?.by_month ?? [];
assert(
  byMonth.every((e) => typeof e.ym === "string" && /^\d{4}-\d{2}$/.test(e.ym) && typeof e.total === "string"),
  "by_month entries are {ym: \"YYYY-MM\", total: decimal-string}",
);
const currentMonthEntry = byMonth.find((e) => e.ym === YM);
assert(
  currentMonthEntry?.total === EXPECT_TOTAL,
  `by_month[${YM}].total === "400.50"`,
  `got ${JSON.stringify(currentMonthEntry?.total)}`,
);
const zeroMonth = byMonth.find((e) => e.ym !== YM);
assert(
  zeroMonth !== undefined && zeroMonth.total === "0.00",
  "other by_month months are zero-filled \"0.00\"",
  `got ${JSON.stringify(zeroMonth?.total)}`,
);
const yms = byMonth.map((e) => e.ym);
assert(
  yms.every((ym, i) => i === 0 || ym > yms[i - 1]),
  "by_month is ascending",
);
// Sanity: a different year must be zero-filled everywhere for this throwaway user.
const otherYear = YYYY - 1;
const other = await call("GET", `/api/v1/reports/yearly?year=${otherYear}`, { token: access });
assert(other.status === 200, `yearly?year=${otherYear} → 200`, `got ${other.status}`);
assert(
  other.json?.total === "0.00" && other.json?.by_month?.length === 12,
  `empty year ${otherYear} → total "0.00", 12 by_month entries`,
  `got total=${JSON.stringify(other.json?.total)} len=${other.json?.by_month?.length}`,
);

console.log(failures === 0 ? "SMOKE OK — all assertions passed" : `SMOKE FAILED — ${failures} assertion(s) failed`);
process.exit(failures === 0 ? 0 : 1);
