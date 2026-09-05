"""T15.3 backup/restore tests (ADR-0012): envelope shape, Decimal-exact
roundtrip into a second user, REPLACE semantics (old rows gone, budget
replaced not merged, fresh PKs / caller-scoped user_id), 401 battery, 422
battery (schema_version 2, negative amt, bad enums, malformed date, …), and
budget upsert semantics preserved after a restore."""

import re
import uuid

import pytest
from helpers import debt_body, expense_body, register_user
from httpx import AsyncClient

BACKUP = "/api/v1/export/backup.json"
RESTORE = "/api/v1/import/restore"
EXP = "/api/v1/expenses"
DEBTS = "/api/v1/debts"
BUDGETS = "/api/v1/budgets"


def _envelope() -> dict[str, object]:
    """Minimal valid restore envelope (all collections empty)."""
    return {
        "schema_version": 1,
        "exported_at": "2026-09-05T00:00:00Z",
        "counts": {"expenses": 0, "debts": 0, "budgets": 0},
        "expenses": [],
        "debts": [],
        "budgets": [],
    }


async def _seed_full_ledger(client: AsyncClient, headers: dict[str, str]) -> None:
    """Expenses (mixed grp/pay/desc), an open + a settled debt, and a budget."""
    seeds = [
        {
            "iso": "2026-09-01",
            "cat": "চা",
            "grp": "food",
            "amt": "30.00",
            "pay": "cash",
            "desc": "চা ও পরোটা",
        },
        {"iso": "2026-08-20", "cat": "কফি", "grp": "other", "amt": "120.55", "pay": "card"},
        {"iso": "2026-09-03", "cat": "রিকশা", "grp": "transport", "amt": "40.00", "pay": "bkash"},
    ]
    for body in seeds:
        r = await client.post(EXP, json=expense_body(**body), headers=headers)
        assert r.status_code == 201, r.text
    r = await client.post(
        DEBTS,
        json=debt_body(
            party="রফিক", dir="lend", amt="2000.00", iso="2026-08-30", note="এমারজেন্সি"
        ),
        headers=headers,
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        DEBTS,
        json=debt_body(party="করিম চাচা", dir="borrow", amt="500.00", iso="2026-08-12"),
        headers=headers,
    )
    assert r.status_code == 201, r.text
    settle = await client.post(
        f"{DEBTS}/{r.json()['id']}/pay", json={"amt": "600.00"}, headers=headers
    )
    assert settle.status_code == 200 and settle.json()["status"] == "FULL"
    r = await client.put(
        BUDGETS,
        json={"total": "25000.00", "cats": {"চা": "3000.00", "রিকশা": "1500.00"}},
        headers=headers,
    )
    assert r.status_code == 200


def _ledger_content(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """Rows minus the regenerated PK and the user scope."""
    return [{k: v for k, v in row.items() if k not in ("id", "user_id")} for row in rows]


async def test_unauth_401(client: AsyncClient) -> None:
    assert (await client.get(BACKUP)).status_code == 401
    assert (await client.post(RESTORE, json={})).status_code == 401
    junk = {"Authorization": "Bearer not-a-token"}
    assert (await client.get(BACKUP, headers=junk)).status_code == 401
    assert (await client.post(RESTORE, json={}, headers=junk)).status_code == 401


async def test_empty_user_backup_shape(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="backup-empty@test.dev")
    r = await client.get(BACKUP, headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    body = r.json()
    assert set(body) == {"schema_version", "exported_at", "counts", "expenses", "debts", "budgets"}
    assert body["schema_version"] == 1
    assert body["counts"] == {"expenses": 0, "debts": 0, "budgets": 0}
    assert body["expenses"] == []
    assert body["debts"] == []
    assert body["budgets"] == []
    # RFC 3339 UTC with trailing Z.
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z", body["exported_at"])


async def test_roundtrip_into_second_user_decimal_exact(client: AsyncClient) -> None:
    a_headers, _ = await register_user(client, email="backup-a@test.dev")
    await _seed_full_ledger(client, a_headers)
    r = await client.get(BACKUP, headers=a_headers)
    assert r.status_code == 200
    original = r.json()
    assert original["counts"] == {"expenses": 3, "debts": 2, "budgets": 1}
    # Money is exact 2dp decimal strings in the backup itself.
    assert [row["amt"] for row in original["expenses"]] == ["120.55", "30.00", "40.00"]

    b_headers, b_id = await register_user(client, email="backup-b@test.dev")
    r = await client.post(RESTORE, json=original, headers=b_headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"restored": {"expenses": 3, "debts": 2, "budgets": 1}}

    r = await client.get(BACKUP, headers=b_headers)
    assert r.status_code == 200
    restored = r.json()
    assert restored["counts"] == original["counts"]
    # Decimal-exact, field-for-field equality (except PK + user scope):
    # includes desc, pay, iso, created_at, settled_at, budget total/cats.
    assert _ledger_content(restored["expenses"]) == _ledger_content(original["expenses"])
    assert _ledger_content(restored["debts"]) == _ledger_content(original["debts"])
    assert _ledger_content(restored["budgets"]) == _ledger_content(original["budgets"])
    assert [row["amt"] for row in restored["expenses"]] == ["120.55", "30.00", "40.00"]
    # Fresh PKs; everything belongs to the RESTORING user, never the file's.
    a_ids = {row["id"] for row in original["expenses"] + original["debts"]}
    b_ids = {row["id"] for row in restored["expenses"] + restored["debts"]}
    assert b_ids.isdisjoint(a_ids)
    b_rows = restored["expenses"] + restored["debts"] + restored["budgets"]
    assert all(row["user_id"] == b_id for row in b_rows)


async def test_restore_replaces_old_rows(client: AsyncClient) -> None:
    headers, user_id = await register_user(client, email="backup-replace@test.dev")
    old_expense_ids = []
    for i, amt in enumerate(("10.00", "20.00")):
        r = await client.post(
            EXP, json=expense_body(iso=f"2026-07-{i + 1:02d}", amt=amt), headers=headers
        )
        assert r.status_code == 201
        old_expense_ids.append(r.json()["id"])
    r = await client.post(
        DEBTS, json=debt_body(party="পুরানো", amt="99.00", iso="2026-07-05"), headers=headers
    )
    assert r.status_code == 201
    old_debt_id = r.json()["id"]
    r = await client.put(
        BUDGETS, json={"total": "999.00", "cats": {"Old": "1.00"}}, headers=headers
    )
    assert r.status_code == 200

    payload = {
        "schema_version": 1,
        "exported_at": "2026-09-05T00:00:00Z",
        "counts": {"expenses": 1, "debts": 1, "budgets": 1},
        "expenses": [
            {
                "id": str(uuid.uuid4()),  # must be ignored — fresh PK below
                "user_id": str(uuid.uuid4()),  # must be ignored — caller scope
                "cat": "চা",
                "grp": "food",
                "amt": "12.34",
                "pay": "cash",
                "desc": None,
                "iso": "2026-01-01",
                "created_at": "2026-01-01T08:30:00Z",  # preserved for ordering
            }
        ],
        "debts": [
            {
                "id": str(uuid.uuid4()),
                "user_id": str(uuid.uuid4()),
                "party": "নতুন",
                "dir": "borrow",
                "amt": "77.00",
                "note": None,
                "iso": "2026-02-02",
                "settled_at": None,
                "created_at": "2026-02-02T10:00:00Z",
            }
        ],
        "budgets": [
            {
                "user_id": str(uuid.uuid4()),
                "total": "5000.00",
                "cats": {"চা": "100.00"},
                "updated_at": "2026-03-03T00:00:00Z",
            }
        ],
    }
    r = await client.post(RESTORE, json=payload, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"restored": {"expenses": 1, "debts": 1, "budgets": 1}}

    r = await client.get(BACKUP, headers=headers)
    body = r.json()
    assert body["counts"] == payload["counts"]
    # Old rows are gone after the replace.
    assert all(row["id"] not in old_expense_ids for row in body["expenses"])
    assert body["debts"][0]["id"] != old_debt_id
    [exp] = body["expenses"]
    assert exp["id"] != payload["expenses"][0]["id"]  # fresh PK
    assert exp["user_id"] == user_id  # IDOR-safe: scoped to the caller
    assert exp["created_at"] == "2026-01-01T08:30:00Z"  # timestamps preserved
    # The budget was REPLACED, not merged with ("Old" must not survive).
    assert body["budgets"] == [{**payload["budgets"][0], "user_id": user_id}]


async def test_budget_upsert_still_works_after_restore(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="backup-budget@test.dev")
    envelope = {
        **_envelope(),
        "budgets": [{"total": "5000.00", "cats": {"চা": "100.00"}}],
    }
    r = await client.post(RESTORE, json=envelope, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {"restored": {"expenses": 0, "debts": 0, "budgets": 1}}

    # PUT after restore must UPDATE the restored row (PK is user_id — a second
    # row cannot exist), keeping the single-row upsert semantics.
    r = await client.put(BUDGETS, json={"total": "31000.00"}, headers=headers)
    assert r.status_code == 200
    assert r.json()["total"] == "31000.00"
    assert r.json()["cats"] == {"চা": "100.00"}  # partial upsert kept restored cats
    r = await client.get(BACKUP, headers=headers)
    assert r.json()["budgets"][0]["total"] == "31000.00"


@pytest.mark.parametrize(
    ("broken", "code"),
    [
        pytest.param({"schema_version": 2}, "unsupported_backup_version", id="schema-v2"),
        pytest.param({"schema_version": "junk"}, "unsupported_backup_version", id="schema-junk"),
        pytest.param(
            {"expenses": [{"cat": "চা", "grp": "food", "amt": "-5.00", "iso": "2026-09-01"}]},
            "invalid_backup_row",
            id="negative-amt",
        ),
        pytest.param(
            {"expenses": [{"cat": "চা", "grp": "food", "amt": "5.00", "pay": "paypal", "iso": "2026-09-01"}]},
            "invalid_backup_row",
            id="bad-pay-enum",
        ),
        pytest.param(
            {"expenses": [{"cat": "চা", "grp": "junk", "amt": "5.00", "iso": "2026-09-01"}]},
            "invalid_backup_row",
            id="bad-grp-enum",
        ),
        pytest.param(
            {"expenses": [{"cat": "চা", "grp": "food", "amt": "5.00", "iso": "01-09-2026"}]},
            "invalid_backup_row",
            id="malformed-date",
        ),
        pytest.param(
            {"expenses": [{"cat": "", "grp": "food", "amt": "5.00", "iso": "2026-09-01"}]},
            "invalid_backup_row",
            id="empty-cat",
        ),
        pytest.param(
            {"debts": [{"party": "রফিক", "dir": "sideways", "amt": "5.00", "iso": "2026-09-01"}]},
            "invalid_backup_row",
            id="bad-debt-dir",
        ),
        pytest.param(
            {"debts": [{"party": "রফিক", "dir": "lend", "amt": "0.00", "iso": "2026-09-01"}]},
            "invalid_backup_row",
            id="zero-debt-amt",
        ),
        pytest.param(
            {"budgets": [{"total": "10.5"}]},
            "invalid_backup_row",
            id="budget-1dp",
        ),
        pytest.param(
            {"budgets": [{"total": "10.00"}, {"total": "20.00"}]},
            "invalid_backup_row",
            id="two-budget-rows",
        ),
    ],
)
async def test_restore_422_battery(
    client: AsyncClient, broken: dict[str, object], code: str
) -> None:
    headers, _ = await register_user(client, email="backup-422@test.dev")
    r = await client.post(RESTORE, json=_envelope() | broken, headers=headers)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    # House bn/en error triple (ADR-0004 §7).
    assert set(detail) == {"code", "message_bn", "message_en"}
    assert detail["code"] == code
    assert isinstance(detail["message_bn"], str) and detail["message_bn"]
    assert isinstance(detail["message_en"], str) and detail["message_en"]
