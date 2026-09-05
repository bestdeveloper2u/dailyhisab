# ADR-0010: Self-hosted API redeploy — healthz-gated restart script, no sudo/systemd

- **Status:** ACCEPTED
- **Date:** 2026-09-05
- **Scope:** deploy/restart_api.sh, deploy/DEPLOY.md §"API redeploy (self-hosted)" — ops only, no `apps/**` or `packages/**` changes
- **Related:** ADR-0001 (stack pins — Valkey/Docker unavailability), ADR-0004 (API conventions — healthz shape), deploy/DEPLOY.md (web/Vercel side of the chain)

## Context

The API ships self-hosted on a single box, as user `hermes`, with **no sudo and no
systemd**: production is a plain `uvicorn app.main:app --host 0.0.0.0 --port 8000`
process, cwd `apps/api` (venv `apps/api/.venv`, `.env` read from that cwd). Public
ingress is a two-hop chain: Vercel (`mydailyhisab.vercel.app`) rewrites `/api/*` to a
Cloudflare **quick** tunnel (`gear-nyc-sides-abs.trycloudflare.com`) that forwards to
`127.0.0.1:8000`. Neither hop can start or supervise a local process, so a "deploy"
ends at whatever uvicorn process happens to be running on the box.

That bit us on **2026-09-05**: the 0.7.0 → 0.9.0 redeploy was done by hand (kill the
old PID, `nohup` a new one), and a stale uvicorn kept serving **v0.7.0 for ~1 day**
while `healthz` answered `ok` the whole time. Nothing gated the restart on the old
process actually being replaced, and nobody diffed the version field — the failure
mode was invisible until someone checked the version.

## Decision

1. **Process management is a checked-in script, not tribal memory:**
   `deploy/restart_api.sh` (bash strict, `set -euo pipefail`):
   - **idempotent guard** — if `/api/v1/healthz` answers and `--force` was not passed,
     print the live version and exit 0. Re-running the script can never kill a healthy
     prod by accident; `--force` is the explicit "restart anyway" (= the redeploy path).
   - **stop stage** — `pgrep -f 'uvicorn app.main:app'` lists PIDs (self/parent PIDs
     excluded so the script can never kill its own invoker), SIGTERM with a 10s grace
     (uvicorn drains in-flight requests), then SIGKILL survivors so port 8000 is free.
   - **start stage** — exactly how prod runs today: `cd apps/api && nohup
     ./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 >>
     /opt/data/khoroch/deploy/uvicorn.log 2>&1 & disown`. Output lands in one log file.
   - **health gate** — poll `healthz` every 1s for up to 15s; success prints the JSON,
     failure exits non-zero pointing at the log (and dumps the log tail if uvicorn
     died mid-startup).
   `DRY_RUN=1` prints the whole plan and touches nothing — the runbook mandates a
   dry run before every real restart.
2. **The API stays an unsupervised background process, tracked by Hermes.**
   `nohup` + `disown` (not a supervisor, not systemd, not Docker — the daemon is still
   unavailable per ADR-0001) is accepted mechanics. Crash recovery is "re-run the
   script", a documented runbook step rather than automation.
3. **Deploys are healthz-gated on the version field.** `healthz` returning
   `{"status":"ok","version":…}` is the single source of truth for "what is
   deployed". The restart itself ends by printing that JSON, and the runbook verifies
   it both locally (`127.0.0.1:8000`) and through the full public chain
   (`mydailyhisab.vercel.app/api/v1/healthz`) — which also proves the Vercel rewrite →
   quick tunnel → `127.0.0.1:8000` path end-to-end. The 2026-09-05 incident class
   ("healthz ok, wrong version") is closed by making the version check part of the
   restart, not an afterthought.

## Consequences

- **Restart = ~2–5s of downtime.** The old process is killed before the new one binds;
  there is no socket handoff / zero-downtime story. Acceptable at this scale; changing
  it implies a supervisor or a reverse-proxy handoff, i.e. a new ADR.
- **Single-host by construction.** Absolute paths for this box, `pgrep`-based
  discovery, no remote execution — moving hosts means editing the script first.
- **No auto-restart on crash.** Without a supervisor, a dead API stays dead until
  someone runs the script; the health gate at least turns "silently down" into a
  non-zero script exit and a clear log pointer.
- **The quick tunnel remains the fragile hop.** Quick-tunnel URLs change when the
  tunnel is recreated, so the Vercel `/api/*` rewrite must be re-pointed; the runbook
  documents the local-vs-public healthz check that detects it. Valkey and Docker are
  still unavailable (ADR-0001 posture unchanged) — this ADR is process management
  only and does not touch KV/caching topology.
