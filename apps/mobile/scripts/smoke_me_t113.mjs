/**
 * T11.3 live contract smoke — GET /api/v1/auth/me (mobile Settings profile).
 * Plain node (>=18, global fetch). Run: node scripts/smoke_me_t113.mjs
 *
 * Creates a THROWAWAY user, then asserts /auth/me echoes the registered
 * profile (id/email/name) and rejects unauthenticated calls with 401.
 * Never touches existing/demo data.
 */
const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8000";

const email = `smoke+me-${Date.now()}@test.local`;
const password = "Test1234!";
const name = "T11.3 Smoke";

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

console.log(`smoke_me_t113 — base=${BASE}`);
console.log(`1) POST /api/v1/auth/register (${email})`);
const reg = await call("POST", "/api/v1/auth/register", {
  body: { email, password, name },
});
assert(reg.status === 201, "register → 201", `got ${reg.status}`);
const access = reg.json?.accessToken;
assert(typeof access === "string" && access.length > 0, "register → accessToken");

console.log("2) GET /api/v1/auth/me (Bearer access)");
if (typeof access === "string") {
  const me = await call("GET", "/api/v1/auth/me", { token: access });
  assert(me.status === 200, "me → 200", `got ${me.status}`);
  assert(me.json?.id !== undefined && me.json?.id !== null, "me → id present");
  assert(me.json?.email === email, "me → email echoes registration", `got ${me.json?.email}`);
  assert(me.json?.name === name, "me → name echoes registration", `got ${me.json?.name}`);
  assert(
    typeof me.json?.id === "string" && typeof me.json?.email === "string",
    "me → shape matches mobile api.User {id,email,name}",
  );

  console.log("3) GET /api/v1/auth/me (no token)");
  const anon = await call("GET", "/api/v1/auth/me");
  assert(anon.status === 401, "me unauthenticated → 401", `got ${anon.status}`);

  console.log("4) GET /api/v1/auth/me (garbage token)");
  const bad = await call("GET", "/api/v1/auth/me", { token: "not-a-token" });
  assert(bad.status === 401, "me bad token → 401", `got ${bad.status}`);
}

console.log(failures === 0 ? "smoke_me_t113: ALL PASS" : `smoke_me_t113: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
