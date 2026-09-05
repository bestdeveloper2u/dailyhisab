/**
 * T12.2 live read-only smoke — mobile expenses-list surface (prototype
 * screen-list parity) against the deployed API. Plain node (>=18, global
 * fetch). Run: node apps/mobile/t12_smoke.mjs
 *
 * READ-ONLY: logs in as the demo user and only GETs (list/search/cursor/CSV);
 * creates one THROWAWAY registration to assert the register→/auth/me pair.
 * Never POSTs /expenses, so demo user data is untouched.
 */
const BASE = process.env.SMOKE_BASE_URL ?? "https://mydailyhisab.vercel.app";
const API = `${BASE.replace(/\/+$/, "")}/api/v1`;

const DEMO_EMAIL = "demo@khoroch.app";
const DEMO_PASSWORD = process.env.SMOKE_DEMO_PASSWORD ?? "demo1234";

const random = Math.random().toString(36).slice(2, 10);
const regEmail = `t12.smoke.${random}@khoroch.app`;
const regPassword = `T12-${random}-xq!`;// ≥8 chars, satisfies the API's rules

let failures = 0;
function assert(cond, label, extra = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`  [${mark}] ${label}${extra !== "" ? ` — ${extra}` : ""}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
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

console.log(`t12_smoke — api=${API}`);

console.log(`1) POST /auth/login (demo user: ${DEMO_EMAIL})`);
const login = await call("POST", "/auth/login", {
  body: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
});
assert(login.status === 200, "login → 200", `got ${login.status}`);
const demoToken = login.json?.accessToken;
assert(
  typeof demoToken === "string" && demoToken.length > 0,
  "login → accessToken present",
);
const demoUser = login.json?.user?.email ?? login.json?.user?.id;
assert(demoUser !== undefined && demoUser !== null, "login → user object present");

console.log(`2) GET /expenses?q=${encodeURIComponent("চা")}`);
const searched = await call("GET", `/expenses?q=${encodeURIComponent("চা")}`, {
  token: demoToken,
});
assert(searched.status === 200, "search → 200", `got ${searched.status}`);
const searchItems = Array.isArray(searched.json?.items) ? searched.json.items : [];
assert(
  searched.status === 200 && Array.isArray(searched.json?.items),
  "search → items array envelope",
  `got ${searchItems.length} item(s)`,
);
assert(
  searchItems.every((e) => typeof e.cat === "string" && e.cat.includes("চা")),
  "every returned cat contains 'চা' (server-side q filter)",
);
assert(
  searchItems.every(
    (e) =>
      typeof e.amt === "string" &&
      /^\d{1,10}\.\d{2}$/.test(e.amt) &&
      typeof e.iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.iso),
  ),
  "search rows keep the wire shape (amt decimal-string, iso YYYY-MM-DD)",
);

console.log("3) GET /expenses (page 1) then cursor page 2 if data allows");
const page1 = await call("GET", "/expenses?limit=5", { token: demoToken });
assert(page1.status === 200, "page1 (limit=5) → 200", `got ${page1.status}`);
const p1Items = Array.isArray(page1.json?.items) ? page1.json.items : [];
assert(p1Items.length <= 5, "page1 respects limit=5", `got ${p1Items.length}`);
const cursor = page1.json?.next_cursor ?? null;
if (cursor !== null) {
  const page2 = await call("GET", `/expenses?limit=5&cursor=${encodeURIComponent(cursor)}`, {
    token: demoToken,
  });
  assert(page2.status === 200, "page2 (cursor) → 200", `got ${page2.status}`);
  const p2Items = Array.isArray(page2.json?.items) ? page2.json.items : [];
  assert(p2Items.length <= 5, "page2 respects limit=5", `got ${p2Items.length}`);
  const p1Ids = new Set(p1Items.map((e) => e.id));
  assert(
    p2Items.every((e) => !p1Ids.has(e.id)),
    "page2 has no id overlap with page1 (keyset advances)",
  );
} else {
  assert(
    p1Items.length <= 5,
    "no next_cursor — dataset fits one page, cursor path not exercisable",
    `${p1Items.length} item(s) total`,
  );
}

console.log("4) GET /export/expenses.csv (Bearer)");
// NOTE: use raw bytes — res.text() applies WHATWG UTF-8 decoding, which strips
// a leading BOM, so the BOM is only observable on the ArrayBuffer.
const csvRes = await fetch(`${API}/export/expenses.csv`, {
  headers: { Authorization: `Bearer ${demoToken}` },
});
const csvBuf = await csvRes.arrayBuffer();
const csvBytes = new Uint8Array(csvBuf);
const csvText = new TextDecoder().decode(csvBuf.slice(3)); // skip EF BB BF
assert(csvRes.status === 200, "csv → 200", `got ${csvRes.status}`);
assert(
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  "csv starts with UTF-8 BOM bytes EF BB BF (Excel needs it for Bengali)",
  `got ${[csvBytes[0], csvBytes[1], csvBytes[2]].map((b) => b?.toString(16)).join(" ")}`,
);
const firstLine = csvText.split(/\r?\n/, 1)[0] ?? "";
assert(
  firstLine === "তারিখ,বিবরণ,গ্রুপ,খাত,পরিমাণ (৳),পেমেন্ট",
  "csv header line is the bn prototype header row",
  JSON.stringify(firstLine),
);
const dataLines = csvText.split(/\r?\n/).filter((line) => line.length > 0);
assert(
  dataLines.length === 1 || dataLines.slice(1).every((l) => /^\d{4}-\d{2}-\d{2},/.test(l)),
  "csv data rows start with an ISO date (iso,desc,grp,cat,amt,pay order)",
  `${dataLines.length - 1} data row(s)`,
);

console.log(`5) POST /auth/register (throwaway: ${regEmail})`);
const reg = await call("POST", "/auth/register", {
  body: { email: regEmail, password: regPassword, name: "T12.2 Smoke" },
});
assert(reg.status === 201, "register → 201", `got ${reg.status}`);
const regToken = reg.json?.accessToken;
assert(
  typeof regToken === "string" && regToken.length > 0,
  "register → accessToken present (auth pair)",
);
const me = await call("GET", "/auth/me", { token: regToken });
assert(me.status === 200, "/auth/me (new register bearer) → 200", `got ${me.status}`);
assert(me.json?.email === regEmail, "/auth/me echoes the registered email", `got ${me.json?.email}`);
assert(me.json?.name === "T12.2 Smoke", "/auth/me echoes the registered name", `got ${me.json?.name}`);

console.log(failures === 0 ? "t12_smoke: ALL PASS" : `t12_smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
