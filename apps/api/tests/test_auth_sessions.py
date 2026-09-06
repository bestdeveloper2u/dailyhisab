"""Session visibility + revocation (T25.3, ADR-0024).

Covers the per-user live-session index (``user_sess:<profile-id>``) and the
two endpoints built on it:

* ``GET /auth/sessions`` — lists only the caller's LIVE sessions (dead index
  members are pruned on read), ``current`` = the token's ``sid`` claim.
* ``POST /auth/sessions/revoke-others`` — tears down every other live
  session with logout semantics (``sess:<sid>`` + ``rt:<hash>`` + index
  srem), keeps the caller's session fully usable, and is idempotent.

KV set operations (SADD/SREM/SMEMBERS) are exercised through the real
MemoryKV the app runs on in tests/local dev.
"""

import time
import uuid
from typing import Any

import jwt as pyjwt
from httpx import AsyncClient

from app.core.config import get_settings
from app.core.kv import MemoryKV
from app.core.security import decode_access_token

AUTH = "/api/v1/auth"


async def register(client: AsyncClient, email: str = "user@test.dev") -> dict[str, Any]:
    r = await client.post(
        f"{AUTH}/register", json={"email": email, "password": "password123"}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def login(client: AsyncClient, email: str = "user@test.dev") -> dict[str, Any]:
    r = await client.post(f"{AUTH}/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200, r.text
    return r.json()


def auth_headers(pair: dict[str, Any]) -> dict[str, str]:
    return {"Authorization": f"Bearer {pair['accessToken']}"}


def sid_of(pair: dict[str, Any]) -> str:
    return str(decode_access_token(pair["accessToken"])["sid"])


async def index_members(kv: MemoryKV, profile_id: str) -> set[str]:
    """Current membership of the profile's live-session index (public API)."""
    return await kv.smembers(f"user_sess:{profile_id}")


async def test_login_adds_session_to_index(client: AsyncClient, kv: MemoryKV) -> None:
    pair = await register(client)
    profile_id = pair["user"]["id"]
    sid = sid_of(pair)
    assert await index_members(kv, profile_id) == {sid}

    # A second login (same user) adds a second live sid to the same index.
    pair2 = await login(client)
    assert pair2["user"]["id"] == profile_id
    assert await index_members(kv, profile_id) == {sid, sid_of(pair2)}


async def test_logout_removes_index_member(client: AsyncClient, kv: MemoryKV) -> None:
    pair = await register(client)
    profile_id = pair["user"]["id"]
    sid = sid_of(pair)
    assert await index_members(kv, profile_id) == {sid}

    r = await client.post(f"{AUTH}/logout", headers=auth_headers(pair))
    assert r.status_code == 204
    assert await index_members(kv, profile_id) == set()
    # Session records died with it (logout semantics unchanged).
    assert await kv.get(f"sess:{sid}") is None


async def test_logout_cookie_removes_index_member(
    client: AsyncClient, kv: MemoryKV
) -> None:
    pair = await register(client)
    profile_id = pair["user"]["id"]
    # Establish the session through the cookie transport.
    rotated = await client.post(
        f"{AUTH}/refresh-cookie", cookies={"kh_refresh": pair["refreshToken"]}
    )
    assert rotated.status_code == 200, rotated.text
    cookie_sid = sid_of(rotated.json())
    assert await index_members(kv, profile_id) == {cookie_sid}

    out = await client.post(
        f"{AUTH}/logout-cookie", cookies={"kh_refresh": rotated.json()["refreshToken"]}
    )
    assert out.status_code == 204
    assert await index_members(kv, profile_id) == set()


async def test_reuse_detection_removes_index_member(
    client: AsyncClient, kv: MemoryKV
) -> None:
    pair = await register(client)
    profile_id = pair["user"]["id"]
    rotated = (await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair["refreshToken"]}
    )).json()
    live_sid = sid_of(rotated)
    assert await index_members(kv, profile_id) == {live_sid}

    # Replay the STALE token → reuse detection kills the whole family.
    replay = await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair["refreshToken"]}
    )
    assert replay.status_code == 401
    assert await index_members(kv, profile_id) == set()
    assert await kv.get(f"sess:{live_sid}") is None


async def test_refresh_rotation_keeps_index_member(
    client: AsyncClient, kv: MemoryKV
) -> None:
    pair = await register(client)
    profile_id = pair["user"]["id"]
    sid = sid_of(pair)
    rotated = (await client.post(
        f"{AUTH}/refresh", json={"refreshToken": pair["refreshToken"]}
    )).json()
    # Same sid survives rotation → index membership unchanged.
    assert sid_of(rotated) == sid
    assert await index_members(kv, profile_id) == {sid}
    assert await kv.exists(f"sess:{sid}")


async def test_get_sessions_lists_only_own_live_sessions(
    client: AsyncClient, kv: MemoryKV
) -> None:
    pair = await register(client)
    other = await register(client, email="other@test.dev")
    second = await login(client)  # a second session of the SAME user

    r = await client.get(f"{AUTH}/sessions", headers=auth_headers(pair))
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"items", "current"}
    ids = [item["id"] for item in body["items"]]
    assert set(ids) == {sid_of(pair), sid_of(second)}
    assert body["current"] == sid_of(pair)
    for item in body["items"]:
        assert set(item) == {"id", "expires_in"}
        assert 0 < item["expires_in"] <= get_settings().refresh_ttl

    # The other user's session is invisible (index is per-profile).
    r_other = await client.get(f"{AUTH}/sessions", headers=auth_headers(other))
    assert [i["id"] for i in r_other.json()["items"]] == [sid_of(other)]
    assert r_other.json()["current"] == sid_of(other)


async def test_get_sessions_prunes_dead_members(
    client: AsyncClient, kv: MemoryKV
) -> None:
    pair = await register(client)
    profile_id = pair["user"]["id"]
    victim = await login(client)
    victim_sid = sid_of(victim)

    # The victim session dies out-of-band (e.g. TTL expiry): its sess record
    # disappears while the index still lists it.
    await kv.delete(f"sess:{victim_sid}")
    assert await index_members(kv, profile_id) == {sid_of(pair), victim_sid}

    r = await client.get(f"{AUTH}/sessions", headers=auth_headers(pair))
    assert r.status_code == 200, r.text
    body = r.json()
    assert [i["id"] for i in body["items"]] == [sid_of(pair)]
    # ...and the dead member was pruned from the index itself.
    assert await index_members(kv, profile_id) == {sid_of(pair)}


async def test_revoke_others_keeps_current_usable(
    client: AsyncClient, kv: MemoryKV
) -> None:
    keep = await register(client)
    victim_a = await login(client)
    victim_b = await login(client)

    r = await client.post(
        f"{AUTH}/sessions/revoke-others", headers=auth_headers(keep)
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"revoked": 2}

    # The current session is untouched and still fully usable.
    assert await index_members(kv, keep["user"]["id"]) == {sid_of(keep)}
    assert await kv.exists(f"sess:{sid_of(keep)}")
    me = await client.get(f"{AUTH}/me", headers=auth_headers(keep))
    assert me.status_code == 200
    assert me.json()["id"] == keep["user"]["id"]
    refreshed = await client.post(
        f"{AUTH}/refresh", json={"refreshToken": keep["refreshToken"]}
    )
    assert refreshed.status_code == 200

    # The others are dead: access tokens and refresh tokens alike.
    for victim in (victim_a, victim_b):
        assert (
            await client.get(f"{AUTH}/me", headers=auth_headers(victim))
        ).status_code == 401
        assert (
            await client.post(
                f"{AUTH}/refresh", json={"refreshToken": victim["refreshToken"]}
            )
        ).status_code == 401
        assert await kv.get(f"sess:{sid_of(victim)}") is None


async def test_revoke_others_is_idempotent(client: AsyncClient, kv: MemoryKV) -> None:
    pair = await register(client)
    headers = auth_headers(pair)
    first = await client.post(f"{AUTH}/sessions/revoke-others", headers=headers)
    assert first.status_code == 200
    assert first.json() == {"revoked": 0}  # nothing else was ever live

    await login(client)
    second = await client.post(f"{AUTH}/sessions/revoke-others", headers=headers)
    assert second.json() == {"revoked": 1}
    third = await client.post(f"{AUTH}/sessions/revoke-others", headers=headers)
    assert third.status_code == 200
    assert third.json() == {"revoked": 0}


async def test_revoke_others_unknown_sid_token_409(client: AsyncClient) -> None:
    pair = await register(client)
    # Forge a legacy/foreign token with NO sid claim (valid signature+sub).
    now = int(time.time())
    token = pyjwt.encode(
        {"sub": pair["user"]["id"], "iat": now, "exp": now + 900},
        get_settings().jwt_secret,
        algorithm="HS256",
    )
    r = await client.post(
        f"{AUTH}/sessions/revoke-others",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert set(detail) == {"code", "message_bn", "message_en"}
    assert detail["message_bn"] and detail["message_en"]

    # GET /sessions tolerates the same token with current: null.
    listing = await client.get(
        f"{AUTH}/sessions", headers={"Authorization": f"Bearer {token}"}
    )
    assert listing.status_code == 200
    assert listing.json()["current"] is None
    assert [i["id"] for i in listing.json()["items"]] == [sid_of(pair)]


async def test_sessions_endpoints_require_auth(client: AsyncClient) -> None:
    assert (await client.get(f"{AUTH}/sessions")).status_code == 401
    assert (
        await client.post(f"{AUTH}/sessions/revoke-others")
    ).status_code == 401
    # A garbage bearer is equally unauthenticated.
    bad = {"Authorization": "Bearer not-a-jwt"}
    assert (await client.get(f"{AUTH}/sessions", headers=bad)).status_code == 401
    assert (
        await client.post(f"{AUTH}/sessions/revoke-others", headers=bad)
    ).status_code == 401


async def test_revoke_others_prunes_dead_without_counting_them(
    client: AsyncClient, kv: MemoryKV
) -> None:
    pair = await register(client)
    stale = await login(client)
    await kv.delete(f"sess:{sid_of(stale)}")  # dies out-of-band
    another = await login(client)

    r = await client.post(
        f"{AUTH}/sessions/revoke-others", headers=auth_headers(pair)
    )
    assert r.json() == {"revoked": 1}  # only the truly-live other session
    assert await index_members(kv, pair["user"]["id"]) == {sid_of(pair)}
    assert await kv.get(f"sess:{sid_of(another)}") is None


async def test_memorykv_set_operations_ttl_semantics() -> None:
    """Direct KV contract: lazy TTL refresh, empty-set deletion, missing keys."""
    kv = MemoryKV()

    assert await kv.smembers("user_sess:none") == set()
    await kv.srem("user_sess:none", "ghost")  # missing key is a no-op

    await kv.sadd("s", "a", ttl_seconds=100)
    await kv.sadd("s", "b", ttl_seconds=100)
    assert await kv.smembers("s") == {"a", "b"}
    assert 0 < await kv.ttl("s") <= 100

    # sadd refreshes the TTL (lazy expiry, like setex on strings).
    await kv.sadd("s", "c", ttl_seconds=100)
    assert await kv.ttl("s") > 90

    await kv.srem("s", "a", "missing")
    assert await kv.smembers("s") == {"b", "c"}
    await kv.srem("s", "b", "c")
    assert await kv.ttl("s") == -2  # empty set → key deleted (Redis semantics)
    assert await kv.smembers("s") == set()


async def test_sessions_of_unknown_user_token_401(client: AsyncClient) -> None:
    """A syntactically valid token for a non-existent profile stays 401."""
    now = int(time.time())
    token = pyjwt.encode(
        {"sub": str(uuid.uuid4()), "sid": "whatever", "iat": now, "exp": now + 900},
        get_settings().jwt_secret,
        algorithm="HS256",
    )
    headers = {"Authorization": f"Bearer {token}"}
    assert (await client.get(f"{AUTH}/sessions", headers=headers)).status_code == 401
    assert (
        await client.post(f"{AUTH}/sessions/revoke-others", headers=headers)
    ).status_code == 401
