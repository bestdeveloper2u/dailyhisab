#!/usr/bin/env python3
"""Cycle-4 E2E smoke of the Phase 1 auth API (Track C). Throwaway harness.

Run: apps/api/.venv/bin/python scripts/smoke_auth_cycle4.py  (uvicorn on :8010)
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8010/api/v1/auth"
JSON_H = {"Content-Type": "application/json"}


def call(
    method: str,
    path: str,
    body: dict | None = None,
    token: str | None = None,
) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def check(label: str, got: int, want: int, extra: str = "") -> None:
    mark = "PASS" if got == want else "FAIL"
    print(f"[{mark}] {label}: {got} (want {want}) {extra}")


s, b = call("POST", "/login", {"email": "demo@khoroch.app", "password": "demo1234"})
check("login demo", s, 200, f"user={b.get('user', {}).get('email') if isinstance(b, dict) else b}")
access1, refresh1 = b["accessToken"], b["refreshToken"]  # type: ignore[index]

s, b = call("GET", "/me", token=access1)
check("me with access", s, 200, str(b.get("email") if isinstance(b, dict) else b))

s, _ = call("GET", "/me")
check("me without token", s, 401)

s, b = call("POST", "/refresh", {"refreshToken": refresh1})
check("refresh rotates", s, 200)
access2, refresh2 = b["accessToken"], b["refreshToken"]  # type: ignore[index]
check("refresh returned NEW token", refresh2 != refresh1, 200, "(differs)")

s, b = call("POST", "/refresh", {"refreshToken": refresh1})
check("REUSE old refresh -> revoked", s, 401, str(b))

s, _ = call("POST", "/refresh", {"refreshToken": refresh2})
check("newest refresh also dead after reuse", s, 401)

s, _ = call("GET", "/me", token=access2)
check("me with newest access after revocation", s, 401)

s, b = call("POST", "/login", {"email": "demo@khoroch.app", "password": "demo1234"})
access3 = b["accessToken"]  # type: ignore[index]
s, _ = call("POST", "/logout", {}, token=access3)
check("logout", s, 204)
s, _ = call("GET", "/me", token=access3)
check("me after logout", s, 401)

codes = [call("POST", "/login", {"email": "rl@x.app", "password": "wrongpass1"})[0] for _ in range(6)]
check("rate limit 6 rapid logins -> last is 429", codes[-1], 429, str(codes))

s, _ = call("POST", "/register", {"email": "demo@khoroch.app", "password": "password123"})
check("register duplicate email", s, 409)

s, b = call("POST", "/register", {"email": "new-user@khoroch.app", "password": "password123", "name": "New"})
check("register new user", s, 201, str(b.get("user", {}).get("email") if isinstance(b, dict) else b))

print("SMOKE COMPLETE")
