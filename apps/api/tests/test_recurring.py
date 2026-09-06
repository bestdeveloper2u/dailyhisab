"""T16.1 recurring expenses tests (ADR-0014): rule create/shape, validation,
list + active filter + cursor pagination, patch (incl. the forward-only
``next_run`` cursor), delete, IDOR scoping, and the idempotent materialization
run (catch-up, day-clamped occurrence math, pause/future skipping, per-user
scoping, report-cache invalidation, catch-up cap)."""

import uuid
from datetime import UTC, date, datetime, timedelta

from helpers import recurring_body, register_user
from httpx import AsyncClient

from app.routers.recurring import (
    _MAX_CATCH_UP,
    _add_months,
    _next_occurrence,
)

REC = "/api/v1/recurring"
EXP = "/api/v1/expenses"


def _today() -> date:
    return datetime.now(UTC).date()


def _iso(d: date) -> str:
    return d.isoformat()


async def _create(
    client: AsyncClient, headers: dict[str, str], **overrides: object
) -> dict:
    r = await client.post(REC, json=recurring_body(**overrides), headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


async def _run(client: AsyncClient, headers: dict[str, str]) -> dict:
    r = await client.post(f"{REC}/run", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


# --- occurrence math (pure, calendar-clamped) -------------------------------


def test_occurrence_math_clamps_short_months() -> None:
    # monthly: Jan 31 → Feb 28 (2026 is not a leap year), and back out to 31.
    assert _next_occurrence(date(2026, 1, 31), "monthly") == date(2026, 2, 28)
    assert _next_occurrence(date(2026, 2, 28), "monthly") == date(2026, 3, 28)
    assert _next_occurrence(date(2026, 1, 30), "monthly") == date(2026, 2, 28)
    # yearly: Feb 29 → Feb 28 in the off year, Feb 29 again on leap 2028.
    assert _next_occurrence(date(2024, 2, 29), "yearly") == date(2025, 2, 28)
    assert _next_occurrence(date(2025, 2, 28), "yearly") == date(2026, 2, 28)
    assert _add_months(date(2024, 2, 29), 48) == date(2028, 2, 29)
    # daily / weekly are plain offsets.
    assert _next_occurrence(date(2026, 9, 5), "daily") == date(2026, 9, 6)
    assert _next_occurrence(date(2026, 9, 5), "weekly") == date(2026, 9, 12)


# --- CRUD --------------------------------------------------------------------


async def test_unauth_401(client: AsyncClient) -> None:
    assert (await client.get(REC)).status_code == 401
    assert (await client.post(REC, json=recurring_body())).status_code == 401
    assert (
        await client.patch(f"{REC}/{uuid.uuid4()}", json={"amt": "1.00"})
    ).status_code == 401
    assert (await client.delete(f"{REC}/{uuid.uuid4()}")).status_code == 401
    assert (await client.post(f"{REC}/run")).status_code == 401


async def test_create_201_and_wire_shape(client: AsyncClient) -> None:
    headers, user_id = await register_user(client, email="rec-create@test.dev")
    body = await _create(client, headers, start_date="2026-10-01", desc=None)
    # Keys mirror the DB columns exactly (ADR-0004).
    assert set(body) == {
        "id",
        "user_id",
        "cat",
        "grp",
        "amt",
        "pay",
        "desc",
        "freq",
        "start_date",
        "next_run",
        "active",
        "created_at",
        "updated_at",
    }
    assert body["amt"] == "12000.00"  # decimal string, never a number
    assert body["desc"] is None  # explicit null, not omitted
    assert body["freq"] == "monthly"
    assert body["start_date"] == "2026-10-01"
    assert body["next_run"] == "2026-10-01"  # cursor starts on the first occurrence
    assert body["active"] is True
    assert body["pay"] == "cash"  # default
    assert body["user_id"] == user_id
    assert len(body["id"]) == 36 and body["id"] == body["id"].lower()
    assert body["created_at"].endswith("Z")  # RFC 3339 UTC
    assert body["updated_at"].endswith("Z")


async def test_create_defaults_start_date_to_today(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-today@test.dev")
    body = await _create(client, headers)
    assert body["start_date"] == _iso(_today())
    assert body["next_run"] == body["start_date"]


async def test_create_validation_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-validate@test.dev")
    for overrides in (
        {"freq": "whenever"},  # not a valid frequency
        {"freq": ""},  # empty
        {"amt": "-5.00"},  # negative
        {"amt": "10.500"},  # 3 decimal places
        {"amt": "10"},  # missing 2dp
        {"amt": 10.0},  # JSON number — money is a string (ADR-0004)
        {"grp": "crypto"},  # not a valid group
        {"pay": "ioU"},  # not a valid payment method
        {"cat": ""},  # empty cat
        {"cat": "x" * 81},  # cat too long
        {"desc": "x" * 201},  # desc too long
        {"start_date": "01-09-2026"},  # bad date format
        {"start_date": "not-a-date"},
    ):
        r = await client.post(REC, json=recurring_body(**overrides), headers=headers)
        assert r.status_code == 422, overrides


async def test_list_order_active_filter_and_pagination(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-list@test.dev")
    made = [
        await _create(
            client,
            headers,
            cat=f"rule-{i:02d}",
            freq="daily",
            start_date=_iso(_today() + timedelta(days=i + 1)),
        )
        for i in range(25)
    ]
    # Pause one rule so the active filter has something to hide.
    paused = made[7]
    r = await client.patch(
        f"{REC}/{paused['id']}", json={"active": False}, headers=headers
    )
    assert r.status_code == 200 and r.json()["active"] is False

    # Expected order: created_at DESC, id DESC — computed from the rows
    # themselves (SQLite created_at has 1s resolution, so same-second rows
    # may tie down to the id tiebreak).
    def sort_key(rule: dict) -> tuple[str, str]:
        return (rule["created_at"], rule["id"])

    expected = sorted(made, key=sort_key, reverse=True)

    # Default: every rule (active filter omitted) — limit=100 > our 25 rows.
    r = await client.get(REC, params={"limit": "100"}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"items", "next_cursor"}
    assert [i["id"] for i in body["items"]] == [i["id"] for i in expected]
    assert body["next_cursor"] is None

    # ?active=true hides the paused rule; ?active=false shows only it.
    r = await client.get(REC, params={"active": "true", "limit": "100"}, headers=headers)
    ids = [i["id"] for i in r.json()["items"]]
    assert paused["id"] not in ids and len(ids) == 24
    r = await client.get(REC, params={"active": "false", "limit": "100"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [paused["id"]]

    # Keyset pagination walks all 25 rows in order across 3 pages.
    seen: list[str] = []
    cursor: str | None = None
    for _ in range(10):
        params: dict[str, str] = {"limit": "10"}
        if cursor is not None:
            params["cursor"] = cursor
        page = (
            await client.get(REC, params=params, headers=headers)
        ).json()
        seen.extend(i["id"] for i in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == [i["id"] for i in expected]
    assert cursor is None


async def test_patch_partial_and_null(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-patch@test.dev")
    rule = await _create(client, headers, desc="বাসা ভাড়া", start_date="2026-09-01")
    r = await client.patch(
        f"{REC}/{rule['id']}",
        json={"cat": "মেস খরচ", "amt": "4500.50", "freq": "weekly"},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["cat"] == "মেস খরচ"  # updated
    assert body["amt"] == "4500.50"  # updated
    assert body["freq"] == "weekly"  # updated
    assert body["desc"] == "বাসা ভাড়া"  # untouched
    assert body["next_run"] == "2026-09-01"  # freq-only change never rewinds/advances
    r = await client.patch(
        f"{REC}/{rule['id']}", json={"desc": None}, headers=headers
    )
    assert r.json()["desc"] is None  # explicit null clears the desc


async def test_patch_next_run_cursor_is_forward_only(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-cursor@test.dev")
    rule = await _create(client, headers, start_date="2026-09-01")
    current = (await client.get(REC, headers=headers)).json()["items"][0]["next_run"]

    # An earlier start_date must NOT rewind the cursor...
    r = await client.patch(
        f"{REC}/{rule['id']}", json={"start_date": "2026-01-01"}, headers=headers
    )
    assert r.status_code == 200
    assert r.json()["next_run"] == current
    assert r.json()["start_date"] == "2026-01-01"

    # ...while a later start_date pushes it forward.
    r = await client.patch(
        f"{REC}/{rule['id']}", json={"start_date": "2027-03-15"}, headers=headers
    )
    assert r.status_code == 200
    assert r.json()["next_run"] == "2027-03-15"
    # next_run is server-owned: a client-supplied value is ignored (pydantic
    # drops unknown/extra keys) and the cursor keeps its computed position.
    r = await client.patch(
        f"{REC}/{rule['id']}",
        json={"next_run": "2020-01-01", "active": False},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["next_run"] == "2027-03-15"
    assert r.json()["active"] is False


async def test_patch_validation_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-patchv@test.dev")
    rule = await _create(client, headers)
    for payload in (
        {"amt": "-1.00"},  # negative (amt >= 0 is legal — mirrors expenses)
        {"amt": "5.5"},
        {"freq": "hourly"},
        {"active": "maybe"},  # not coercible to a bool
        {"start_date": "2026/09/01"},
    ):
        r = await client.patch(
            f"{REC}/{rule['id']}", json=payload, headers=headers
        )
        assert r.status_code == 422, payload


async def test_idor_404_user_scoping(client: AsyncClient) -> None:
    headers_a, _ = await register_user(client, email="rec-idor-a@test.dev")
    headers_b, _ = await register_user(client, email="rec-idor-b@test.dev")
    b_rule = await _create(client, headers_b, cat="b only")

    foreign = f"{REC}/{b_rule['id']}"
    assert (
        await client.patch(foreign, json={"cat": "hacked"}, headers=headers_a)
    ).status_code == 404
    assert (await client.delete(foreign, headers=headers_a)).status_code == 404
    # B's row is untouched by all of A's attempts, and A's run cannot see it.
    r = await client.get(REC, headers=headers_b)
    assert [i["id"] for i in r.json()["items"]] == [b_rule["id"]]
    assert r.json()["items"][0]["cat"] == "b only"

    unknown = f"{REC}/{uuid.uuid4()}"
    for method, kwargs in (("patch", {"json": {"cat": "x"}}), ("delete", {})):
        r = await getattr(client, method)(unknown, headers=headers_a, **kwargs)
        assert r.status_code == 404


async def test_delete_204(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-del@test.dev")
    rule = await _create(client, headers)
    r = await client.delete(f"{REC}/{rule['id']}", headers=headers)
    assert r.status_code == 204
    assert r.content == b""
    # Gone from the list, and a second delete 404s.
    assert (await client.get(REC, headers=headers)).json()["items"] == []
    assert (await client.delete(f"{REC}/{rule['id']}", headers=headers)).status_code == 404


# --- materialization run ------------------------------------------------------


async def test_run_materializes_due_occurrences_and_is_idempotent(
    client: AsyncClient,
) -> None:
    headers, user_id = await register_user(client, email="rec-run@test.dev")
    today = _today()
    start = today - timedelta(days=3)  # 4 occurrences due: start..today
    await _create(
        client,
        headers,
        cat="চা",
        grp="food",
        amt="50.00",
        pay="bkash",
        desc="প্রতিদিনের চা",
        freq="daily",
        start_date=_iso(start),
    )

    body = await _run(client, headers)
    assert set(body) == {"ran_on", "created", "rules", "expenses"}
    assert body["ran_on"] == _iso(today)
    assert body["created"] == 4
    assert body["rules"] == 1
    assert [e["iso"] for e in body["expenses"]] == [
        _iso(start + timedelta(days=k)) for k in range(4)
    ]
    first = body["expenses"][0]
    assert first["amt"] == "50.00"  # copied column-for-column
    assert first["cat"] == "চা"
    assert first["grp"] == "food"
    assert first["pay"] == "bkash"
    assert first["desc"] == "প্রতিদিনের চা"
    assert first["user_id"] == user_id
    assert first["created_at"].endswith("Z")

    # The cursor advanced past today, so an immediate re-run is a no-op.
    again = await _run(client, headers)
    assert again["created"] == 0 and again["rules"] == 0 and again["expenses"] == []
    rule_after = (await client.get(REC, headers=headers)).json()["items"][0]
    assert rule_after["next_run"] == _iso(today + timedelta(days=1))

    # The materialized rows are real expenses, visible on the ledger.
    ledger = (await client.get(EXP, headers=headers)).json()
    assert sorted(e["iso"] for e in ledger["items"]) == [
        _iso(start + timedelta(days=k)) for k in range(4)
    ]
    assert len(ledger["items"]) == 4  # and nothing extra was inserted


async def test_run_monthly_catches_up_with_clamped_days(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-monthly@test.dev")
    today = _today()
    # Exactly two occurrences are due: start = today - 32d, and start + 1 month
    # (>= 28d later, so <= today-4d; the third lands >= today+24d, safely due
    # on a LATER run) — independent of which day of the month today is.
    start = today - timedelta(days=32)
    await _create(
        client, headers, freq="monthly", amt="12000.00", start_date=_iso(start)
    )
    body = await _run(client, headers)
    second = _next_occurrence(start, "monthly")
    third = _next_occurrence(second, "monthly")
    assert [e["iso"] for e in body["expenses"]] == [_iso(start), _iso(second)]
    assert all(e["amt"] == "12000.00" for e in body["expenses"])
    assert body["created"] == 2
    rule_after = (await client.get(REC, headers=headers)).json()["items"][0]
    assert rule_after["next_run"] == _iso(third)


async def test_run_skips_paused_and_future_rules(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-skip@test.dev")
    today = _today()
    paused = await _create(
        client,
        headers,
        cat="paused",
        freq="daily",
        start_date=_iso(today - timedelta(days=2)),
    )
    r = await client.patch(
        f"{REC}/{paused['id']}", json={"active": False}, headers=headers
    )
    assert r.status_code == 200
    future = await _create(
        client,
        headers,
        cat="future",
        freq="daily",
        start_date=_iso(today + timedelta(days=30)),
    )
    assert future["next_run"] == future["start_date"]

    body = await _run(client, headers)
    assert body["created"] == 0 and body["rules"] == 0
    # Both cursors untouched: paused keeps its due next_run, future keeps its
    # future one — unpausing resumes from where the rule left off.
    items = {i["cat"]: i for i in (await client.get(REC, headers=headers)).json()["items"]}
    assert items["paused"]["next_run"] == _iso(today - timedelta(days=2))
    assert items["future"]["next_run"] == _iso(today + timedelta(days=30))


async def test_run_is_per_user(client: AsyncClient) -> None:
    headers_a, _ = await register_user(client, email="rec-run-a@test.dev")
    headers_b, uid_b = await register_user(client, email="rec-run-b@test.dev")
    today = _today()
    # B has a due rule; A does not.
    await _create(
        client, headers_b, cat="b-only", freq="daily", start_date=_iso(today)
    )
    body_a = await _run(client, headers_a)
    assert body_a["created"] == 0
    body_b = await _run(client, headers_b)
    assert body_b["created"] == 1
    assert all(e["user_id"] == uid_b for e in body_b["expenses"])
    # B's expense exists; A still has an empty ledger.
    assert (await client.get(EXP, headers=headers_a)).json()["items"] == []
    b_ledger = (await client.get(EXP, headers=headers_b)).json()["items"]
    assert [e["cat"] for e in b_ledger] == ["b-only"]


async def test_run_invalidates_report_cache(
    client: AsyncClient, kv: object
) -> None:
    headers, uid = await register_user(client, email="rec-cache@test.dev")
    today = _today()
    await _create(client, headers, freq="daily", start_date=_iso(today), amt="99.00")
    ym = f"{today.year:04d}-{today.month:02d}"
    key = f"rep:monthly:{uid}:{ym}"
    await kv.setex(key, 300, "stale")  # type: ignore[attr-defined]
    assert await kv.get(key) is not None  # type: ignore[attr-defined]

    body = await _run(client, headers)
    assert body["created"] == 1
    assert await kv.get(key) is None  # type: ignore[attr-defined]


async def test_run_catch_up_is_capped_per_run(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="rec-cap@test.dev")
    today = _today()
    start = today - timedelta(days=250)  # 251 daily occurrences are due
    await _create(
        client, headers, cat="catchup", freq="daily", start_date=_iso(start)
    )

    total = 0
    for _ in range(10):  # 251 occurrences / cap 120 → 3 runs
        body = await _run(client, headers)
        assert body["created"] <= _MAX_CATCH_UP
        total += body["created"]
        if body["created"] == 0:
            break
    # Eventually EVERYTHING materializes — the cap defers, never drops.
    expected = (today - start).days + 1
    assert total == expected
    # Page through the whole ledger (default page size is 20).
    ledger: list[dict] = []
    cursor: str | None = None
    while True:
        params: dict[str, str] = {"limit": "100"}
        if cursor is not None:
            params["cursor"] = cursor
        page = (await client.get(EXP, params=params, headers=headers)).json()
        ledger.extend(page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(ledger) == expected
    isos = sorted(e["iso"] for e in ledger)
    assert isos[0] == _iso(start) and isos[-1] == _iso(today)
