"""Phase 3 debts tests: create/shape, validation, list + status filter +
cursor pagination, patch, pay close-out (PARTIAL/FULL/409), delete, and
per-user scoping (IDOR → 404)."""

import uuid
from datetime import UTC, datetime

import pytest
from helpers import debt_body, register_user
from httpx import AsyncClient

DEBTS = "/api/v1/debts"


def _today() -> str:
    return datetime.now(UTC).date().isoformat()


async def _create(client: AsyncClient, headers: dict[str, str], **overrides: object) -> dict:
    r = await client.post(DEBTS, json=debt_body(**overrides), headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


async def test_unauth_401(client: AsyncClient) -> None:
    assert (await client.get(DEBTS)).status_code == 401
    assert (await client.post(DEBTS, json=debt_body())).status_code == 401
    assert (
        await client.patch(f"{DEBTS}/{uuid.uuid4()}", json={"party": "x"})
    ).status_code == 401
    assert (await client.post(f"{DEBTS}/{uuid.uuid4()}/pay", json={"amt": "1.00"})).status_code == 401
    assert (await client.delete(f"{DEBTS}/{uuid.uuid4()}")).status_code == 401


async def test_create_201_and_wire_shape(client: AsyncClient) -> None:
    headers, user_id = await register_user(client, email="debt-create@test.dev")
    body = await _create(client, headers, note=None)
    # Keys mirror the DB columns exactly (ADR-0004).
    assert set(body) == {
        "id",
        "user_id",
        "party",
        "dir",
        "amt",
        "note",
        "iso",
        "settled_at",
        "created_at",
    }
    assert body["amt"] == "2000.00"  # decimal string, never a number
    assert body["note"] is None  # explicit null, not omitted
    assert body["settled_at"] is None  # open debt
    assert body["iso"] == _today()  # defaults to today
    assert body["dir"] == "lend"
    assert body["party"] == "রফিক"
    assert body["created_at"].endswith("Z")  # RFC 3339 UTC
    assert body["user_id"] == user_id
    assert len(body["id"]) == 36 and body["id"] == body["id"].lower()


@pytest.mark.parametrize(
    "overrides",
    [
        {"dir": "steal"},  # not lend/borrow
        {"amt": "-5.00"},  # negative
        {"amt": "0.00"},  # zero (DB CHECK amt > 0)
        {"amt": "10.500"},  # 3 decimal places
        {"amt": "10"},  # missing 2dp
        {"amt": 10.0},  # JSON number — money is a string (ADR-0004)
        {"party": ""},  # empty party
        {"party": "x" * 121},  # party too long
        {"iso": "01-09-2026"},  # bad date format
    ],
)
async def test_create_validation_422(
    client: AsyncClient, overrides: dict[str, object]
) -> None:
    headers, _ = await register_user(client, email="debt-validate@test.dev")
    r = await client.post(DEBTS, json=debt_body(**overrides), headers=headers)
    assert r.status_code == 422


async def test_list_status_filter_and_order(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-list@test.dev")
    older = await _create(client, headers, party="a", iso="2026-08-01")
    newer = await _create(client, headers, party="b", iso="2026-09-02")
    same_day = await _create(client, headers, party="c", iso="2026-09-02")
    today_row = await _create(client, headers, party="d", amt="100.00")
    # Settle the newest row (FULL pay).
    pay = await client.post(
        f"{DEBTS}/{today_row['id']}/pay", json={"amt": "100.00"}, headers=headers
    )
    assert pay.json()["status"] == "FULL"

    # Expected order: iso DESC, then created_at DESC / id DESC tiebreak —
    # computed from the rows themselves (SQLite created_at has 1s resolution,
    # so the two same-day rows may tie down to the id tiebreak).
    def sort_key(debt: dict) -> tuple[str, str]:
        return (debt["created_at"], debt["id"])

    pair = sorted([newer, same_day], key=sort_key, reverse=True)

    # Default = open only (today_row was just settled, so it is excluded).
    r = await client.get(DEBTS, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"items", "next_cursor"}
    assert [i["id"] for i in body["items"]] == [
        pair[0]["id"],
        pair[1]["id"],
        older["id"],
    ]
    assert all(i["settled_at"] is None for i in body["items"])

    r = await client.get(DEBTS, params={"status": "settled"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [today_row["id"]]
    r = await client.get(DEBTS, params={"status": "all"}, headers=headers)
    ids = [i["id"] for i in r.json()["items"]]
    assert ids == [
        today_row["id"],
        pair[0]["id"],
        pair[1]["id"],
        older["id"],
    ]


async def test_list_pagination_cursor(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-page@test.dev")
    made = [
        await _create(client, headers, party=f"p{i:02d}", iso=f"2026-09-{i + 1:02d}")
        for i in range(25)
    ]
    seen: list[str] = []
    cursor: str | None = None
    for _ in range(10):  # 25 rows / limit 10 → 3 pages
        params: dict[str, str] = {"limit": "10"}
        if cursor is not None:
            params["cursor"] = cursor
        body = (await client.get(DEBTS, params=params, headers=headers)).json()
        seen.extend(i["id"] for i in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert seen == [d["id"] for d in reversed(made)]  # iso DESC across pages
    assert cursor is None


async def test_patch_partial_and_null(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-patch@test.dev")
    debt = await _create(client, headers, note="এমারজেন্সি")
    r = await client.patch(
        f"{DEBTS}/{debt['id']}",
        json={"party": "করিম", "amt": "2500.50"},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["party"] == "করিম"  # updated
    assert body["amt"] == "2500.50"  # updated
    assert body["note"] == "এমারজেন্সি"  # untouched
    r = await client.patch(
        f"{DEBTS}/{debt['id']}", json={"note": None}, headers=headers
    )
    assert r.json()["note"] is None  # explicit null clears the note


async def test_patch_validation_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-patchv@test.dev")
    debt = await _create(client, headers)
    for payload in ({"amt": "0.00"}, {"dir": "gift"}, {"amt": "5.5"}):
        r = await client.patch(
            f"{DEBTS}/{debt['id']}", json=payload, headers=headers
        )
        assert r.status_code == 422, payload


async def test_pay_partial_then_full(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-pay@test.dev")
    debt = await _create(client, headers, amt="100.00")
    r = await client.post(
        f"{DEBTS}/{debt['id']}/pay", json={"amt": "40.00"}, headers=headers
    )
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"status", "debt"}
    assert body["status"] == "PARTIAL"
    assert body["debt"]["amt"] == "60.00"  # reduced
    assert body["debt"]["settled_at"] is None  # still open

    r = await client.post(
        f"{DEBTS}/{debt['id']}/pay", json={"amt": "60.00"}, headers=headers
    )
    body = r.json()
    assert body["status"] == "FULL"
    assert body["debt"]["amt"] == "60.00"  # unchanged on FULL
    assert body["debt"]["settled_at"] is not None
    assert body["debt"]["settled_at"].endswith("Z")


async def test_pay_overpay_is_full(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-over@test.dev")
    debt = await _create(client, headers, amt="100.00")
    r = await client.post(
        f"{DEBTS}/{debt['id']}/pay", json={"amt": "150.00"}, headers=headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "FULL"
    assert body["debt"]["amt"] == "100.00"  # overpay never recorded


async def test_pay_already_settled_409(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-409@test.dev")
    debt = await _create(client, headers, amt="50.00")
    first = await client.post(
        f"{DEBTS}/{debt['id']}/pay", json={"amt": "50.00"}, headers=headers
    )
    assert first.json()["status"] == "FULL"
    r = await client.post(
        f"{DEBTS}/{debt['id']}/pay", json={"amt": "10.00"}, headers=headers
    )
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert detail["code"] == "debt_already_settled"
    assert detail["message_bn"] and detail["message_en"]


async def test_pay_validation_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-payv@test.dev")
    debt = await _create(client, headers)
    for payload in ({"amt": "0.00"}, {"amt": "-1.00"}, {}, {"amt": "5"}, {"amt": "5.005"}):
        r = await client.post(
            f"{DEBTS}/{debt['id']}/pay", json=payload, headers=headers
        )
        assert r.status_code == 422, payload


async def test_idor_404_user_scoping(client: AsyncClient) -> None:
    headers_a, _ = await register_user(client, email="idor-a@test.dev")
    headers_b, _ = await register_user(client, email="idor-b@test.dev")
    b_debt = await _create(client, headers_b, party="b only")

    foreign = f"{DEBTS}/{b_debt['id']}"
    assert (await client.patch(foreign, json={"party": "hacked"}, headers=headers_a)).status_code == 404
    assert (
        await client.post(f"{foreign}/pay", json={"amt": "1.00"}, headers=headers_a)
    ).status_code == 404
    assert (await client.delete(foreign, headers=headers_a)).status_code == 404
    # B's row is untouched by all of A's attempts.
    r = await client.get(DEBTS, headers=headers_b)
    assert [i["id"] for i in r.json()["items"]] == [b_debt["id"]]
    assert r.json()["items"][0]["party"] == "b only"

    unknown = f"{DEBTS}/{uuid.uuid4()}"
    for method, kwargs in (
        ("patch", {"json": {"party": "x"}}),
        ("post", {"json": {"amt": "1.00"}}),
        ("delete", {}),
    ):
        url = f"{unknown}/pay" if method == "post" else unknown
        r = await getattr(client, method)(url, headers=headers_a, **kwargs)
        assert r.status_code == 404


async def test_delete_204(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="debt-del@test.dev")
    debt = await _create(client, headers)
    r = await client.delete(f"{DEBTS}/{debt['id']}", headers=headers)
    assert r.status_code == 204
    assert r.content == b""
    # Gone from the list, and a second delete 404s.
    assert (await client.get(DEBTS, headers=headers)).json()["items"] == []
    assert (await client.delete(f"{DEBTS}/{debt['id']}", headers=headers)).status_code == 404
