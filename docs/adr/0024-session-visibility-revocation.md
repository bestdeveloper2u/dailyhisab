# ADR-0024: Session visibility + revoke-other-sessions

- Status: ACCEPTED (2026-09-06, cycle 25)
- Deciders: CEO (scope), CTO (merge); researched by PM
- Tags: auth, security, kv, sessions, zero-migration

## Context

A financial ledger must give users control over every device that can read
their books. Until this cycle the auth layer (ADR-0002) had **zero session
visibility**: sessions lived in KV as `sess:<sid>` / `rt:<hash>` pairs with no
per-user grouping, so a user who left a phone logged in could neither see that
session nor revoke it — the only lever was changing the password, which
doesn't invalidate KV sessions at all. Reuse detection (family kill on
refresh-token replay) protects against *attackers*, not against *oneself*.

## Decision

Add a per-user live-session index and two authenticated, user-scoped
endpoints under `/api/v1/auth` (JSON body transport, Bearer-authenticated):

- **`GET /auth/sessions`** → `{items: [{id, expires_in}], current}` — every
  LIVE session of the caller; `expires_in` is the remaining KV TTL of
  `sess:<id>` (what the refresh token has left). `current` is the caller's
  own session id.
- **`POST /auth/sessions/revoke-others`** → `{revoked: n}` — tears down every
  other live session with exactly the logout semantics (`sess:<sid>` and its
  current `rt:<hash>` deleted together, sid removed from the index). The
  caller's own session, access token, and refresh token are untouched.
  Idempotent: a second call answers `{"revoked": 0}`.

### KV index design

New key `user_sess:<profile-id>` = **SET** of that profile's live session
ids. The KV ABC gains three verbs, implemented on both backends:
`sadd(key, member, ttl_seconds=None)`, `srem(key, *members)`,
`smembers(key) -> set[str]`. MemoryKV keeps a second dict-of-sets with the
same lazy loop-time TTL as its string keys; RedisKV maps the verbs 1:1 onto
SADD/SREM/SMEMBERS. Maintenance is entirely at the existing mutation points
in `app/routers/auth.py`:

- login/register (shared `_issue_session`) → `sadd` the new sid;
- logout (JSON **and** cookie paths) and reuse-detection family kill →
  `srem` the affected sid;
- refresh rotation keeps the **same sid** (verified: `sess:<sid>` is updated
  in place and the new access token re-embeds it), so membership never
  changes on rotation — the idempotent `sadd` there only refreshes the index
  TTL in lockstep with the refreshed session records, so a long-lived
  rotating session can never outlive its index;
- readers (`GET /sessions`, revoke-others) **prune defensively**: any index
  member whose `sess:<sid>` is missing/expired (or whose session record
  belongs to a different profile) is dropped from the index on sight and
  never surfaced. The index is an optimization, never an authority —
  liveness is always decided by `sess:<sid>`.
- `srem` of the last member deletes the key outright (Redis semantics), so
  the namespace holds no empty husks.

### Current-session identification

The access JWT has carried a `sid` claim since ADR-0002
(`create_access_token` embeds it; `get_current_session` already relies on
it), so `current` is read straight from the caller's token claims — no new
transport, no cookie sniffing, no state. For robustness against foreign or
legacy issuers whose tokens lack `sid`, a tolerant dependency
(`get_current_session_tolerant`) authenticates the *profile* but yields
`sid = None`: `GET /sessions` then answers `current: null`, and
revoke-others **refuses with 409**
(`{"code": "current_session_unknown", "message_bn": …, "message_en": …}`,
ADR-0004 §7 triple) rather than guessing which session to spare — a mass
revoke that kills the phone in your hand is worse than no revoke.

## Consequences

- Users can finally see and remotely revoke their own sessions; the flow
  needs no schema/migration — it is pure KV.
- **MemoryKV-in-prod caveat:** prod currently runs MemoryKV
  (`KHOROCH_KV_URL` empty; the Docker/Valkey deployment is still down) on a
  single uvicorn process. The feature is *correct within the process* but
  inherits today's semantics: a restart clears all sessions and the index,
  and the index would NOT be shared across multiple workers. When Valkey
  comes back, `RedisKV` picks the feature up unchanged (same verbs).
- Visibility is eventually-consistent by design: dead sessions disappear
  from the listing on the next read (prune-on-read), not via a reaper.
- `expires_in`/`current` are derived values; clients must not treat session
  ids as stable identifiers across re-login (a new login mints a new sid).
- The 409 path is deliberately narrow: every token the API itself mints has
  `sid`, so real clients only meet it with third-party tokens.
