"""Phase 2 voice/parse tests: rule-based Bengali transcript parsing."""

from datetime import UTC, datetime

from helpers import register_user
from httpx import AsyncClient

VOICE = "/api/v1/voice/parse"


async def test_parse_two_items_bengali(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice1@test.dev")
    r = await client.post(
        VOICE, json={"text": "চা ৫০ এবং রিকশা ৪০"}, headers=headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"items", "confidence"}
    items = body["items"]
    assert len(items) == 2
    first, second = items
    assert first["cat"] == "চা"
    assert first["grp"] == "food"
    assert first["amt"] == "50.00"
    assert second["cat"] == "রিকশা"
    assert second["grp"] == "transport"
    assert second["amt"] == "40.00"
    assert body["confidence"] == 0.95
    today = datetime.now(UTC).date().isoformat()
    assert all(i["iso"] == today for i in items)


async def test_parse_english_keyword_decimal(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice2@test.dev")
    r = await client.post(VOICE, json={"text": "coffee 120.50"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["grp"] == "food"
    assert item["amt"] == "120.50"
    assert body["confidence"] == 0.95


async def test_parse_digits_only_is_other(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice3@test.dev")
    r = await client.post(VOICE, json={"text": "৫০"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["grp"] == "other"
    assert item["cat"] == "other"
    assert item["amt"] == "50.00"
    assert body["confidence"] == 0.6


async def test_parse_nothing_parsed(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice4@test.dev")
    r = await client.post(VOICE, json={"text": "hello"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == []
    assert body["confidence"] == 0.0


async def test_parse_thousand_multiplier(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice5@test.dev")
    r = await client.post(VOICE, json={"text": "বই ১ হাজার"}, headers=headers)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["grp"] == "education"
    assert items[0]["amt"] == "1000.00"


async def test_parse_number_word_amount_low_confidence(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice6@test.dev")
    r = await client.post(VOICE, json={"text": "চা পাঁচ টাকা"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"][0]["grp"] == "food"
    assert body["items"][0]["amt"] == "5.00"
    assert body["confidence"] == 0.3  # keyword, but the amount is a number-word


async def test_parse_multi_separator_split(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice7@test.dev")
    r = await client.post(
        VOICE,
        json={"text": "চা 30, রিকশা 40; বই 100\nওয়াইফাই 500 ও কফি 20.25"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 5
    grps = [i["grp"] for i in items]
    assert grps == ["food", "transport", "education", "utility", "food"]
    amts = [i["amt"] for i in items]
    assert amts == ["30.00", "40.00", "100.00", "500.00", "20.25"]


async def test_parse_housing_vs_transport_bhara(client: AsyncClient) -> None:
    """ভাড়া alone → housing; রিকশা/বাস context → transport."""
    headers, _ = await register_user(client, email="voice8@test.dev")
    r = await client.post(
        VOICE, json={"text": "বাসা ভাড়া 8000 এবং বাস ভাড়া 15"}, headers=headers
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 2
    assert items[0]["grp"] == "housing"
    assert items[0]["amt"] == "8000.00"
    assert items[1]["grp"] == "transport"
    assert items[1]["amt"] == "15.00"


async def test_parse_payment_method_keyword(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice9@test.dev")
    r = await client.post(
        VOICE, json={"text": "বিকাশে বিজলির বিল 950"}, headers=headers
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["grp"] == "utility"
    assert items[0]["pay"] == "bkash"
    assert items[0]["amt"] == "950.00"


async def test_parse_validation_and_auth(client: AsyncClient) -> None:
    headers, _ = await register_user(client, email="voice10@test.dev")
    r = await client.post(VOICE, json={"text": ""}, headers=headers)
    assert r.status_code == 422
    r = await client.post(VOICE, json={"text": "x" * 501}, headers=headers)
    assert r.status_code == 422
    r = await client.post(VOICE, json={"text": "চা 50"})  # no token
    assert r.status_code == 401
