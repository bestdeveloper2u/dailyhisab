"""Phase 2 expenses tests: create/shape, validation, list filters, cursor
pagination, bulk insert, patch, delete, and per-user scoping."""

import base64

import pytest
from helpers import expense_body, register_user
from httpx import AsyncClient

EXP = "/api/v1/expenses"


async def test_create_201_and_wire_shape(client: AsyncClient) -> None:
    headers, user_id = await register_user(client, email="create@test.dev")
    r = await client.post(EXP, json=expense_body(desc=None), headers=headers)
    assert r.status_code == 201, r.text
    body = r.json()
    # Keys mirror the DB columns exactly (ADR-0004).
    assert set(body) == {
        "id",
        "user_id",
        "cat",
        "grp",
        "amt",
        "pay",
        "desc",
        "iso",
        "created_at",
    }
    assert body["amt"] == "50.00"  # decimal string, never a number
    assert body["desc"] is None  # explicit null, not omitted
    assert body["pay"] == "cash"  # server default
    assert body["cat"] == "চা"
    assert body["iso"] == "2026-09-01"
    assert body["created_at"].endswith("Z")  # RFC 3339 UTC
    assert len(body["id"]) == 36
    assert body["id"] == body["id"].lower()
    assert body["user_id"] == user_id


@pytest.mark.parametrize(
    "overrides",
    [
        {"grp": "stuff"},  # not a valid group
        {"amt": "-5.00"},  # negative
        {"amt": "50.500"},  # 3 decimal places
        {"amt": "50"},  # missing 2dp
        {"amt": 50.0},  # JSON number — money is a string (ADR-0004)
        {"cat": ""},  # empty category
        {"desc": "x" * 201},  # desc too long
        {"iso": "01-09-2026"},  # bad date format
    ],
)
async def test_create_validation_422(
    client: AsyncClient, overrides: dict[str, object]
) -> None:
    headers, _ = await register_user(client, email="validate@test.dev")
    r = await client.post(EXP, json=expense_body(**overrides), headers=headers)
    assert r.status_code == 422


async def test_bulk_validation_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="bulkval@test.dev")
    r = await client.post(f"{EXP}/bulk", json={"items": []}, headers=headers)
    assert r.status_code == 422
    too_many = [expense_body(cat=f"i{i}") for i in range(51)]
    r = await client.post(f"{EXP}/bulk", json={"items": too_many}, headers=headers)
    assert r.status_code == 422


async def test_list_and_filters(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="filters@test.dev")
    e1 = (
        await client.post(
            EXP,
            json=expense_body(cat="চা", amt="50.00", iso="2026-09-01", desc="morning tea"),
            headers=headers,
        )
    ).json()
    e2 = (
        await client.post(
            EXP,
            json=expense_body(cat="রিকশা", grp="transport", amt="40.00", iso="2026-09-03"),
            headers=headers,
        )
    ).json()
    e3 = (
        await client.post(
            EXP,
            json=expense_body(cat="coffee", amt="120.00", iso="2026-08-20", desc="with friends"),
            headers=headers,
        )
    ).json()

    # Ordered iso DESC; envelope is {items, next_cursor}.
    r = await client.get(EXP, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"items", "next_cursor"}
    assert [i["id"] for i in body["items"]] == [e2["id"], e1["id"], e3["id"]]
    assert body["next_cursor"] is None

    # from / to are inclusive on iso (e3's 2026-08-20 ≤ 2026-09-02, e2's
    # 2026-09-03 > it); ordering stays iso DESC.
    r = await client.get(EXP, params={"from": "2026-09-01"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [e2["id"], e1["id"]]
    r = await client.get(EXP, params={"to": "2026-09-02"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [e1["id"], e3["id"]]
    r = await client.get(
        EXP, params={"from": "2026-09-01", "to": "2026-09-03"}, headers=headers
    )
    assert [i["id"] for i in r.json()["items"]] == [e2["id"], e1["id"]]

    # q: case-insensitive substring on desc OR cat.
    r = await client.get(EXP, params={"q": "COF"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [e3["id"]]
    r = await client.get(EXP, params={"q": "friend"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [e3["id"]]
    r = await client.get(EXP, params={"q": "চা"}, headers=headers)
    assert [i["id"] for i in r.json()["items"]] == [e1["id"]]
    r = await client.get(EXP, params={"q": "zzz-no-match"}, headers=headers)
    assert r.json()["items"] == []

    # limit respected; a full page yields a cursor.
    r = await client.get(EXP, params={"limit": 2}, headers=headers)
    assert len(r.json()["items"]) == 2
    assert r.json()["next_cursor"] is not None


async def test_cursor_pagination_walk(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="pager@test.dev")
    created: list[dict[str, object]] = []
    for day in range(1, 26):  # 25 rows, iso 2026-09-01..2026-09-25
        r = await client.post(
            EXP,
            json=expense_body(cat=f"item-{day:02d}", amt="10.00", iso=f"2026-09-{day:02d}"),
            headers=headers,
        )
        assert r.status_code == 201, r.text
        created.append(r.json())

    expected = [
        e["id"] for e in sorted(created, key=lambda e: str(e["iso"]), reverse=True)
    ]
    seen: list[object] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, object] = {"limit": 10}
        if cursor is not None:
            params["cursor"] = cursor
        r = await client.get(EXP, params=params, headers=headers)
        assert r.status_code == 200, r.text
        body = r.json()
        seen.extend(i["id"] for i in body["items"])
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert pages == 3  # 10 + 10 + 5
    assert seen == expected  # exact global order — no dupes, no losses
    assert len(set(seen)) == 25


async def test_invalid_cursor_400(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="cursor@test.dev")
    bad_cursors = [
        "garbage",  # not base64
        base64.urlsafe_b64encode(b"no-separator-here").decode(),  # no "|"
        base64.urlsafe_b64encode(b"2026-09-01|not-a-uuid").decode(),  # bad uuid
    ]
    for bad in bad_cursors:
        r = await client.get(EXP, params={"cursor": bad}, headers=headers)
        assert r.status_code == 400, r.text
        detail = r.json()["detail"]
        assert detail["code"] == "invalid_cursor"
        assert set(detail) == {"code", "message_bn", "message_en"}


async def test_bulk_201(client: AsyncClient) -> None:
    headers, user_id = await register_user(client, email="bulk@test.dev")
    r = await client.post(
        f"{EXP}/bulk",
        json={
            "items": [
                expense_body(cat="চা", amt="30.00", iso="2026-09-01"),
                expense_body(
                    cat="রিকশা", grp="transport", amt="40.00", iso="2026-09-02", pay="bkash"
                ),
                expense_body(
                    cat="বই", grp="education", amt="1000.00", iso="2026-09-03", desc="বই কেনা"
                ),
            ]
        },
        headers=headers,
    )
    assert r.status_code == 201, r.text
    items = r.json()["items"]
    assert len(items) == 3
    assert all(i["user_id"] == user_id for i in items)
    assert [i["amt"] for i in items] == ["30.00", "40.00", "1000.00"]
    assert [i["pay"] for i in items] == ["cash", "bkash", "cash"]
    # All three really landed.
    r = await client.get(EXP, headers=headers)
    assert len(r.json()["items"]) == 3


async def test_patch_partial_update(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="patch@test.dev")
    created = (
        await client.post(EXP, json=expense_body(desc="orig"), headers=headers)
    ).json()

    r = await client.patch(
        f"{EXP}/{created['id']}", json={"desc": "updated"}, headers=headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["desc"] == "updated"
    assert body["amt"] == "50.00"  # untouched
    assert body["grp"] == "food"
    assert body["iso"] == "2026-09-01"

    r = await client.patch(
        f"{EXP}/{created['id']}",
        json={"amt": "60.00", "grp": "transport", "pay": "card"},
        headers=headers,
    )
    body = r.json()
    assert body["amt"] == "60.00"
    assert body["grp"] == "transport"
    assert body["pay"] == "card"
    assert body["desc"] == "updated"  # still untouched

    # Explicit null clears desc; omitted keys stay put.
    r = await client.patch(
        f"{EXP}/{created['id']}", json={"desc": None}, headers=headers
    )
    assert r.json()["desc"] is None
    assert r.json()["amt"] == "60.00"


async def test_delete_204_then_404(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="delete@test.dev")
    created = (await client.post(EXP, json=expense_body(), headers=headers)).json()
    r = await client.delete(f"{EXP}/{created['id']}", headers=headers)
    assert r.status_code == 204
    assert r.content == b""
    r = await client.delete(f"{EXP}/{created['id']}", headers=headers)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    r = await client.get(EXP, headers=headers)
    assert r.json()["items"] == []


async def test_patch_delete_unknown_id_404(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="unknown@test.dev")
    missing = "00000000-0000-0000-0000-000000000000"
    r = await client.patch(f"{EXP}/{missing}", json={"amt": "1.00"}, headers=headers)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    r = await client.delete(f"{EXP}/{missing}", headers=headers)
    assert r.status_code == 404


async def test_user_scoping(client: AsyncClient) -> None:
    headers_a, uid_a = await register_user(client, email="owner@test.dev")
    headers_b, uid_b = await register_user(client, email="intruder@test.dev")
    assert uid_a != uid_b
    created = (await client.post(EXP, json=expense_body(), headers=headers_a)).json()

    # B's list never contains A's rows.
    r = await client.get(EXP, headers=headers_b)
    assert r.json()["items"] == []
    # B cannot patch or delete A's expense — 404, never 403 (no existence leak).
    r = await client.patch(
        f"{EXP}/{created['id']}", json={"amt": "1.00"}, headers=headers_b
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"
    r = await client.delete(f"{EXP}/{created['id']}", headers=headers_b)
    assert r.status_code == 404
    # A's row is intact.
    r = await client.get(EXP, headers=headers_a)
    assert [i["amt"] for i in r.json()["items"]] == ["50.00"]


async def test_endpoints_require_auth(client: AsyncClient) -> None:
    assert (await client.get(EXP)).status_code == 401
    assert (await client.post(EXP, json=expense_body())).status_code == 401
    assert (await client.post(f"{EXP}/bulk", json={"items": [expense_body()]})).status_code == 401
