"""Phase 3 CSV export tests: BOM + header row, RFC 4180 quoting (Bengali
desc with comma/quote/newline), ordering, range validation, empty range,
per-user scoping, and OWASP CSV-injection defense (T8.5a)."""

import csv
import io
from datetime import UTC, datetime

from helpers import expense_body, register_user
from httpx import AsyncClient

EXP = "/api/v1/expenses"
EXPORT = "/api/v1/export/expenses.csv"
BOM = "\ufeff"
HEADER = ["তারিখ", "বিবরণ", "গ্রুপ", "খাত", "পরিমাণ (৳)", "পেমেন্ট"]


def _today_filename() -> str:
    return f"expenses-{datetime.now(UTC).date():%Y%m%d}.csv"


async def _seed(
    client: AsyncClient, headers: dict[str, str]
) -> None:
    seeds = [
        {"iso": "2026-09-01", "desc": "চা ও পরোটা", "amt": "30.00"},
        {
            "iso": "2026-09-03",
            "desc": 'চা, "দুধ"\nসকাল',  # comma + quotes + newline
            "amt": "50.50",
        },
        {"iso": "2026-08-20", "desc": "with friends", "amt": "120.00"},
    ]
    for body in seeds:
        r = await client.post(EXP, json=expense_body(**body), headers=headers)
        assert r.status_code == 201, r.text


async def test_headers_bom_and_row_order(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="export-basic@test.dev")
    await _seed(client, headers)
    r = await client.get(EXPORT, headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert "charset=utf-8" in r.headers["content-type"]
    assert (
        r.headers["content-disposition"]
        == f'attachment; filename="{_today_filename()}"'
    )
    assert r.content[:3] == b"\xef\xbb\xbf"  # UTF-8 BOM first
    text = r.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    assert rows[0] == HEADER
    # Ordered iso ASC: 08-20, then 09-01, then 09-03.
    assert [row[0] for row in rows[1:]] == ["2026-08-20", "2026-09-01", "2026-09-03"]
    assert rows[1] == ["2026-08-20", "with friends", "food", "চা", "120.00", "cash"]
    assert rows[3][1] == 'চা, "দুধ"\nসকাল'  # round-trips exactly
    assert rows[3][4] == "50.50"


async def test_rfc4180_quoting_raw_bytes(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="export-quote@test.dev")
    await _seed(client, headers)
    r = await client.get(EXPORT, headers=headers)
    text = r.content.decode("utf-8-sig")  # also strips the BOM
    # The comma/quote/newline field is wrapped in quotes with embedded
    # quotes doubled, per RFC 4180 §2.7.
    assert text.split("2026-08-20")[0] == f'{",".join(HEADER)}\r\n'
    assert '"চা, ""দুধ""\nসকাল"' in text
    # Plain fields are NOT quoted (minimal quoting).
    assert "with friends" in text


async def test_empty_range_header_only(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="export-empty@test.dev")
    await _seed(client, headers)
    r = await client.get(
        EXPORT, params={"from": "2030-01-01", "to": "2030-12-31"}, headers=headers
    )
    assert r.status_code == 200
    assert r.content.decode("utf-8") == f'{BOM}{",".join(HEADER)}\r\n'


async def test_from_to_filter(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="export-filter@test.dev")
    await _seed(client, headers)
    r = await client.get(
        EXPORT, params={"from": "2026-09-01"}, headers=headers
    )
    text = r.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    assert [row[0] for row in rows[1:]] == ["2026-09-01", "2026-09-03"]
    r = await client.get(EXPORT, params={"to": "2026-08-31"}, headers=headers)
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"), newline="")))
    assert [row[0] for row in rows[1:]] == ["2026-08-20"]


async def test_from_greater_than_to_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="export-range@test.dev")
    r = await client.get(
        EXPORT, params={"from": "2026-09-03", "to": "2026-09-01"}, headers=headers
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_date_range"


async def test_bad_date_422(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="export-baddate@test.dev")
    r = await client.get(EXPORT, params={"from": "01-09-2026"}, headers=headers)
    assert r.status_code == 422


async def test_user_scoping(client: AsyncClient) -> None:
    headers_a, _ = await register_user(client, email="export-a@test.dev")
    headers_b, _ = await register_user(client, email="export-b@test.dev")
    await _seed(client, headers_b)
    r = await client.get(EXPORT, headers=headers_a)
    text = r.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    assert rows[1:] == []  # A sees none of B's rows, header only


async def test_unauth_401(client: AsyncClient) -> None:
    assert (await client.get(EXPORT)).status_code == 401


async def test_csv_formula_injection_defense(client: AsyncClient) -> None:
    """OWASP CSV Injection (T8.5a): a cell whose FIRST character is ``= + - @
    TAB CR`` is exported with a leading apostrophe so Excel/LibreOffice treat
    it as text, not a formula. Plain Bengali text passes through UNCHANGED.
    Rows use distinct iso dates so ``iso ASC`` ordering is deterministic."""
    headers, _ = await register_user(client, email="export-formula@test.dev")
    dangerous = [
        '=HYPERLINK("http://evil","x")',
        "=cmd|' /C calc'!A0",
        "+123",
        "-456",
        "@SUM(A1)",
        "\tTAB",
        "\rCR",
    ]
    for i, desc in enumerate(dangerous):
        r = await client.post(
            EXP,
            json=expense_body(iso=f"2026-09-{i + 1:02d}", desc=desc, amt="10.00"),
            headers=headers,
        )
        assert r.status_code == 201, r.text
    # Plain Bengali desc (harmless first char) + a formula-like cat name:
    # desc must come through untouched, cat must be guarded.
    r = await client.post(
        EXP,
        json=expense_body(
            iso="2026-10-01", desc="চায়ে ৪০ টাকা", cat="@খাত", amt="40.00"
        ),
        headers=headers,
    )
    assert r.status_code == 201, r.text

    resp = await client.get(EXPORT, headers=headers)
    assert resp.status_code == 200
    text = resp.content.decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    data = rows[1:]
    assert len(data) == len(dangerous) + 1
    # Exact expected cell values, in iso-ASC order (2026-09-01..07, 10-01).
    for row, original in zip(data, dangerous):
        assert row[1] == f"'{original}"
    assert data[-1][1] == "চায়ে ৪০ টাকা"  # UNCHANGED — no apostrophe
    assert data[-1][2] == "food"  # grp: server-validated enum, untouched
    assert data[-1][3] == "'@খাত"  # free-text cat is guarded
    # Server-generated cells stay untouched.
    assert data[-1][0] == "2026-10-01"
    assert data[-1][4] == "40.00"
    assert data[-1][5] == "cash"
    # RFC 4180 quoting intact for the guarded HYPERLINK cell (comma + quotes
    # → wrapped in doubled quotes), per §2.7.
    assert '"\'=HYPERLINK(""http://evil"",""x"")"' in text
