"""Phase 3 budgets tests: defaults for a missing row, ym validation, PUT
upsert round-trip, and usage math against seeded expenses."""

import pytest
from helpers import expense_body, register_user
from httpx import AsyncClient

BUDGETS = "/api/v1/budgets"
EXP = "/api/v1/expenses"


async def test_unauth_401(client: AsyncClient) -> None:
    assert (await client.get(BUDGETS)).status_code == 401
    assert (await client.put(BUDGETS, json={"total": "100.00"})).status_code == 401


async def test_defaults_for_missing_row(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="budget-def@test.dev")
    r = await client.get(BUDGETS, params={"ym": "2026-09"}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"ym", "total", "cats", "spent", "usage_pct", "by_cat"}
    assert body["ym"] == "2026-09"
    assert body["total"] == "20000.00"  # DB default, quantized string
    assert body["cats"] == {}
    assert body["spent"] == "0.00"
    assert body["usage_pct"] == 0.0
    assert body["by_cat"] == {}


@pytest.mark.parametrize("ym", ["junk", "2026-13", "2026-9", "2026", "26-09", ""])
async def test_invalid_ym_422(client: AsyncClient, ym: str) -> None:
    headers, _ = await register_user(client, email="budget-ym@test.dev")
    r = await client.get(BUDGETS, params={"ym": ym}, headers=headers)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_ym"


async def test_put_round_trip_and_default_month(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="budget-put@test.dev")
    payload = {
        "total": "25000.00",
        "cats": {"চা": "3000.00", "রিকশা": "1500.00"},
    }
    r = await client.put(BUDGETS, json=payload, headers=headers)
    assert r.status_code == 200
    put_body = r.json()
    assert put_body["total"] == "25000.00"
    assert put_body["cats"] == payload["cats"]

    # PUT returns the GET-shaped body for the current month: an immediate
    # GET without ?ym must match it exactly.
    r = await client.get(BUDGETS, headers=headers)
    assert r.json() == put_body

    # A second PUT with only one field leaves the other untouched (upsert).
    r = await client.put(BUDGETS, json={"total": "30000.00"}, headers=headers)
    assert r.json()["total"] == "30000.00"
    assert r.json()["cats"] == payload["cats"]


@pytest.mark.parametrize(
    "payload",
    [
        {"total": "-5.00"},  # negative
        {"total": "5.5"},  # 1 decimal place
        {"total": "5"},  # missing 2dp
        {"total": 5.0},  # JSON number
        {"cats": {"চা": "10.5"}},  # 1 decimal place
        {"cats": {"চা": "-5.00"}},  # negative category budget
        {"cats": {"চা": 5}},  # JSON number value
        {"cats": {"": "5.00"}},  # empty category name
        {"cats": {"x" * 81: "5.00"}},  # category name too long
    ],
)
async def test_put_validation_422(
    client: AsyncClient, payload: dict[str, object]
) -> None:
    headers, _ = await register_user(client, email="budget-val@test.dev")
    r = await client.put(BUDGETS, json=payload, headers=headers)
    assert r.status_code == 422, payload


async def test_usage_math_against_seeded_expenses(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="budget-math@test.dev")
    # Two চা (food) entries + one রিকশা (transport) in 2026-09, plus a
    # 2026-08 row that must NOT leak into the September math.
    seeds = [
        {"cat": "চা", "grp": "food", "amt": "50.00", "iso": "2026-09-01"},
        {"cat": "চা", "grp": "food", "amt": "30.00", "iso": "2026-09-03"},
        {"cat": "রিকশা", "grp": "transport", "amt": "40.00", "iso": "2026-09-03"},
        {"cat": "কফি", "grp": "food", "amt": "120.00", "iso": "2026-08-20"},
    ]
    for body in seeds:
        r = await client.post(EXP, json=expense_body(**body), headers=headers)
        assert r.status_code == 201, r.text

    r = await client.put(
        BUDGETS,
        json={"total": "200.00", "cats": {"চা": "100.00"}},
        headers=headers,
    )
    assert r.status_code == 200

    r = await client.get(BUDGETS, params={"ym": "2026-09"}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["ym"] == "2026-09"
    assert body["total"] == "200.00"
    assert body["spent"] == "120.00"  # 50 + 30 + 40, August excluded
    assert body["usage_pct"] == 60.0
    # by_cat = union of budgeted cats and cats with spend in the month.
    assert body["by_cat"]["চা"] == {"budget": "100.00", "spent": "80.00", "usage_pct": 80.0}
    assert body["by_cat"]["রিকশা"] == {"budget": "0.00", "spent": "40.00", "usage_pct": 0.0}
    assert "কফি" not in body["by_cat"]  # August-only category absent
