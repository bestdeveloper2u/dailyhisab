"""Phase 2 reports tests: monthly/yearly aggregates, KV caching, and
cache invalidation on expense writes."""

import json
from datetime import UTC, datetime

from helpers import expense_body, register_user
from httpx import AsyncClient

EXP = "/api/v1/expenses"
REP = "/api/v1/reports"


async def _seed_three(client: AsyncClient, headers: dict[str, str]) -> None:
    """100.00 food (Sep 1) + 40.50 transport (Sep 3) + 500.00 utility (Aug 15)."""
    posts = [
        expense_body(cat="চা", grp="food", amt="100.00", iso="2026-09-01"),
        expense_body(cat="রিকশা", grp="transport", amt="40.50", iso="2026-09-03"),
        expense_body(cat="বিজলি", grp="utility", amt="500.00", iso="2026-08-15"),
    ]
    for payload in posts:
        r = await client.post(EXP, json=payload, headers=headers)
        assert r.status_code == 201, r.text


async def test_monthly_report_payload_and_cache(client: AsyncClient, kv: object) -> None:
    headers, uid = await register_user(client, email="rep1@test.dev")
    await _seed_three(client, headers)

    r = await client.get(f"{REP}/monthly", params={"ym": "2026-09"}, headers=headers)
    assert r.status_code == 200, r.text
    first = r.json()
    assert first == {
        "ym": "2026-09",
        "total": "140.50",
        "count": 2,
        "by_group": {"food": "100.00", "transport": "40.50"},
        "by_day": [
            {"iso": "2026-09-01", "total": "100.00"},
            {"iso": "2026-09-03", "total": "40.50"},
        ],
    }

    # Second call: identical payload (served from cache), key present in KV.
    r2 = await client.get(f"{REP}/monthly", params={"ym": "2026-09"}, headers=headers)
    assert r2.json() == first
    key = f"rep:monthly:{uid}:2026-09"
    cached_raw = await kv.get(key)  # type: ignore[attr-defined]
    assert cached_raw is not None
    assert json.loads(cached_raw) == first
    assert 0 < await kv.ttl(key) <= 300  # type: ignore[attr-defined]


async def test_yearly_report_twelve_months(client: AsyncClient, kv: object) -> None:
    headers, uid = await register_user(client, email="rep2@test.dev")
    await _seed_three(client, headers)

    r = await client.get(f"{REP}/yearly", params={"year": "2026"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["year"] == 2026
    assert body["total"] == "640.50"
    assert body["count"] == 3
    assert body["by_group"] == {
        "food": "100.00",
        "transport": "40.50",
        "utility": "500.00",
    }
    by_month = body["by_month"]
    assert len(by_month) == 12  # zero months included
    assert by_month[7] == {"ym": "2026-08", "total": "500.00"}
    assert by_month[8] == {"ym": "2026-09", "total": "140.50"}
    assert sum(1 for entry in by_month if entry["total"] == "0.00") == 10

    # Cache hit on the second call + KV key present.
    r2 = await client.get(f"{REP}/yearly", params={"year": "2026"}, headers=headers)
    assert r2.json() == body
    key = f"rep:yearly:{uid}:2026"
    cached_raw = await kv.get(key)  # type: ignore[attr-defined]
    assert cached_raw is not None
    assert json.loads(cached_raw) == body


async def test_write_invalidates_monthly_cache(client: AsyncClient, kv: object) -> None:
    headers, uid = await register_user(client, email="rep3@test.dev")
    e1 = (
        await client.post(
            EXP,
            json=expense_body(amt="100.00", iso="2026-09-01"),
            headers=headers,
        )
    ).json()
    r = await client.post(
        EXP,
        json=expense_body(amt="25.50", iso="2026-09-05"),
        headers=headers,
    )
    assert r.status_code == 201

    first = (
        await client.get(f"{REP}/monthly", params={"ym": "2026-09"}, headers=headers)
    ).json()
    assert first["count"] == 2
    key = f"rep:monthly:{uid}:2026-09"
    assert await kv.get(key) is not None  # type: ignore[attr-defined]

    # PATCH invalidates: total must move from 125.50 to 130.50.
    r = await client.patch(
        f"{EXP}/{e1['id']}", json={"amt": "105.00"}, headers=headers
    )
    assert r.status_code == 200
    assert await kv.get(key) is None  # type: ignore[attr-defined]
    after_patch = (
        await client.get(f"{REP}/monthly", params={"ym": "2026-09"}, headers=headers)
    ).json()
    assert after_patch["total"] == "130.50"
    assert after_patch["count"] == 2

    # DELETE invalidates too.
    r = await client.delete(f"{EXP}/{e1['id']}", headers=headers)
    assert r.status_code == 204
    after_delete = (
        await client.get(f"{REP}/monthly", params={"ym": "2026-09"}, headers=headers)
    ).json()
    assert after_delete == {
        "ym": "2026-09",
        "total": "25.50",
        "count": 1,
        "by_group": {"food": "25.50"},
        "by_day": [{"iso": "2026-09-05", "total": "25.50"}],
    }


async def test_write_invalidates_yearly_cache(client: AsyncClient, kv: object) -> None:
    headers, uid = await register_user(client, email="rep4@test.dev")
    await client.post(
        EXP,
        json=expense_body(cat="চা", grp="food", amt="100.00", iso="2026-09-01"),
        headers=headers,
    )
    first = (
        await client.get(f"{REP}/yearly", params={"year": "2026"}, headers=headers)
    ).json()
    assert first["count"] == 1
    key = f"rep:yearly:{uid}:2026"
    assert await kv.get(key) is not None  # type: ignore[attr-defined]

    # A write in ANY month of the year must bust the yearly cache.
    r = await client.post(
        EXP,
        json=expense_body(cat="বিজলি", grp="utility", amt="500.00", iso="2026-08-15"),
        headers=headers,
    )
    assert r.status_code == 201
    assert await kv.get(key) is None  # type: ignore[attr-defined]
    second = (
        await client.get(f"{REP}/yearly", params={"year": "2026"}, headers=headers)
    ).json()
    assert second["count"] == 2
    assert second["total"] == "600.00"


async def test_report_defaults_and_empty_month(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rep5@test.dev")
    today = datetime.now(UTC).date()
    r = await client.post(
        EXP,
        json=expense_body(amt="99.99", iso=today.isoformat()),
        headers=headers,
    )
    assert r.status_code == 201, r.text

    # No ym → current month.
    r = await client.get(f"{REP}/monthly", headers=headers)
    body = r.json()
    assert body["ym"] == f"{today.year:04d}-{today.month:02d}"
    assert body["count"] == 1
    assert body["total"] == "99.99"

    # No year → current year (includes the 99.99).
    r = await client.get(f"{REP}/yearly", headers=headers)
    body = r.json()
    assert body["year"] == today.year
    assert body["total"] == "99.99"

    # An empty month aggregates to zeros.
    r = await client.get(f"{REP}/monthly", params={"ym": "2025-01"}, headers=headers)
    assert r.json() == {
        "ym": "2025-01",
        "total": "0.00",
        "count": 0,
        "by_group": {},
        "by_day": [],
    }


async def test_report_bad_params_400(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rep6@test.dev")
    r = await client.get(f"{REP}/monthly", params={"ym": "2026-13"}, headers=headers)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_ym"
    r = await client.get(f"{REP}/monthly", params={"ym": "september"}, headers=headers)
    assert r.status_code == 400
    r = await client.get(f"{REP}/yearly", params={"year": "abcd"}, headers=headers)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "invalid_year"
    r = await client.get(f"{REP}/yearly", params={"year": "99999"}, headers=headers)
    assert r.status_code == 400


async def test_reports_are_per_user(client: AsyncClient, kv: object) -> None:
    headers_a, _ = await register_user(client, email="repa@test.dev")
    headers_b, uid_b = await register_user(client, email="repb@test.dev")
    await _seed_three(client, headers_a)
    # B sees nothing of A's months — separate cache keys, separate aggregates.
    r = await client.get(f"{REP}/monthly", params={"ym": "2026-09"}, headers=headers_b)
    assert r.json() == {
        "ym": "2026-09",
        "total": "0.00",
        "count": 0,
        "by_group": {},
        "by_day": [],
    }
    # B's cache key is only populated by B's own (zero) aggregate.
    cached = await kv.get(f"rep:monthly:{uid_b}:2026-09")  # type: ignore[attr-defined]
    assert cached is not None
    assert json.loads(cached)["count"] == 0


async def test_reports_require_auth(client: AsyncClient) -> None:
    assert (await client.get(f"{REP}/monthly")).status_code == 401
    assert (await client.get(f"{REP}/yearly")).status_code == 401
