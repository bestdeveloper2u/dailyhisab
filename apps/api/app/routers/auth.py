"""Phase 1 auth: register, login, refresh (rotating), logout, me.

Session model in KV (see app/core/kv.py for the key layout):

* ``rt:<sha256(refresh)>`` → ``<sid>`` — one entry per token ever issued for
  the session. Entries are *kept* after rotation so that presenting a stale
  token is detectable (the mapping to ``sid`` is what makes reuse detection
  possible); validity is decided solely by ``sess:<sid>``.
* ``sess:<sid>`` → ``<profile-id>:<sha256(current refresh)>`` — the only
  pointer to the currently valid refresh token for the session. Logout and
  reuse detection delete it, which instantly kills the session's access
  tokens too (:mod:`app.core.deps` checks its existence on every request).
* ``user_sess:<profile-id>`` → SET of that profile's live session ids
  (ADR-0024). Maintained alongside the keys above: login/register add the
  new sid, logout (both transports) and reuse detection remove it. Rotation
  keeps the same sid, so it only refreshes the index TTL (via an idempotent
  SADD) — never the membership. Readers prune stale members defensively.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.cookies import (
    REFRESH_COOKIE_NAME,
    clear_refresh_cookie,
    set_refresh_cookie,
)
from app.core.deps import (
    get_current_session,
    get_current_session_tolerant,
    get_kv_dep,
)
from app.core.kv import KV
from app.core.security import (
    create_access_token,
    dummy_verify,
    hash_password,
    new_refresh_token,
    new_session_id,
    sha256_hex,
    verify_password,
)
from app.db.session import get_db
from app.models.profile import DEMO_USER_NAME, Profile
from app.schemas.auth import (
    AuthOut,
    LoginIn,
    RefreshIn,
    RegisterIn,
    RevokeOthersOut,
    SessionItemOut,
    SessionProbeOut,
    SessionsOut,
    UserOut,
)

router = APIRouter(prefix="/auth", tags=["auth"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
KvDep = Annotated[KV, Depends(get_kv_dep)]
CurrentSession = Annotated[tuple[Profile, str], Depends(get_current_session)]
LooseSession = Annotated[
    tuple[Profile, str | None], Depends(get_current_session_tolerant)
]

# Fixed-window rate limit on credential endpoints.
RATE_WINDOW_SECONDS = 60

_CREDENTIALS_401_HEADERS = {"WWW-Authenticate": "Bearer"}

# 409 detail triple (ADR-0004 §7) for revoke-others when the caller's access
# token carries no ``sid`` claim: the endpoint refuses to guess which session
# to keep, and revokes nothing.
_CURRENT_SESSION_UNKNOWN = {
    "code": "current_session_unknown",
    "message_bn": "বর্তমান সেশনটি শনাক্ত করা যায়নি; অন্য কোনো সেশন বাতিল হয়নি",
    "message_en": "Current session could not be identified; no other session was revoked",
}


async def enforce_rate_limit(kv: KV, request: Request, email: str | None) -> None:
    """Fixed-window limit (INCR+EXPIRE) keyed by client IP + email bucket."""
    settings: Settings = get_settings()
    client = request.client
    ip = client.host if client is not None else "unknown"
    bucket = f"rl:{ip}|{email or '-'}"
    count = await kv.incr(bucket, RATE_WINDOW_SECONDS)
    if count > settings.auth_rate_limit:
        retry_after = max(await kv.ttl(bucket), 1)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(retry_after)},
        )


def _sess_value(profile_id: str, refresh_hash: str) -> str:
    return f"{profile_id}:{refresh_hash}"


def _split_sess(value: str) -> tuple[str, str]:
    profile_id, _, refresh_hash = value.partition(":")
    return profile_id, refresh_hash


def _user_sess_key(profile_id: str) -> str:
    """Per-user live-session index key (ADR-0024): set of live sids."""
    return f"user_sess:{profile_id}"


async def _issue_session(kv: KV, profile: Profile) -> tuple[str, str]:
    """Create a session in KV and return ``(access_token, refresh_token)``."""
    settings = get_settings()
    sid = new_session_id()
    refresh_raw, refresh_hash = new_refresh_token()
    await kv.setex(f"rt:{refresh_hash}", settings.refresh_ttl, sid)
    await kv.setex(
        f"sess:{sid}", settings.refresh_ttl, _sess_value(str(profile.id), refresh_hash)
    )
    # Index the session for its profile (ADR-0024), TTL in lockstep with the
    # session records themselves.
    await kv.sadd(_user_sess_key(str(profile.id)), sid, ttl_seconds=settings.refresh_ttl)
    access = create_access_token(str(profile.id), sid)
    return access, refresh_raw


def _auth_out(profile: Profile, access: str, refresh: str) -> AuthOut:
    # Constructed via the camelCase aliases (AuthOut uses populate_by_name,
    # so both spellings validate — aliases keep mypy's generated signature happy).
    return AuthOut(
        user=UserOut.model_validate(profile),
        accessToken=access,
        refreshToken=refresh,
    )


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=AuthOut)
async def register(
    body: RegisterIn, request: Request, db: DbDep, kv: KvDep
) -> AuthOut:
    """Create a profile and start a session (201 with a fresh token pair)."""
    await enforce_rate_limit(kv, request, body.email)
    email = body.email.strip().lower()
    existing = await db.scalar(select(Profile).where(Profile.email == email))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Email already registered"
        )
    profile = Profile(
        id=uuid.uuid4(),
        email=email,
        name=body.name or DEMO_USER_NAME,
        password_hash=hash_password(body.password),
    )
    db.add(profile)
    await db.commit()
    access, refresh = await _issue_session(kv, profile)
    return _auth_out(profile, access, refresh)


@router.post("/login", response_model=AuthOut)
async def login(body: LoginIn, request: Request, db: DbDep, kv: KvDep) -> AuthOut:
    """Verify credentials and start a session (401 with a uniform message)."""
    await enforce_rate_limit(kv, request, body.email)
    email = body.email.strip().lower()
    profile = await db.scalar(select(Profile).where(Profile.email == email))
    if profile is None:
        dummy_verify(body.password)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers=_CREDENTIALS_401_HEADERS,
        )
    if not verify_password(profile.password_hash, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers=_CREDENTIALS_401_HEADERS,
        )
    access, refresh = await _issue_session(kv, profile)
    return _auth_out(profile, access, refresh)


@router.post("/refresh", response_model=AuthOut)
async def refresh(body: RefreshIn, request: Request, db: DbDep, kv: KvDep) -> AuthOut:
    """Rotate a refresh token; reuse of an old token revokes the session."""
    await enforce_rate_limit(kv, request, None)
    profile, access, refresh_raw = await _rotate_refresh(kv, db, body.refresh_token)
    return _auth_out(profile, access, refresh_raw)


async def _rotate_refresh(
    kv: KV, db: AsyncSession, presented_raw: str
) -> tuple[Profile, str, str]:
    """Validate + rotate a presented refresh token (shared by both transports).

    The JSON endpoint and ``/auth/refresh-cookie`` must behave IDENTICALLY:
    same KV keys, same reuse-detection (family kill), same status codes and
    detail messages. Returns ``(profile, access_token, new_refresh_raw)``.
    """
    settings = get_settings()
    presented = sha256_hex(presented_raw)

    sid = await kv.get(f"rt:{presented}")
    if sid is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    sess_value = await kv.get(f"sess:{sid}")
    if sess_value is None:
        # Session logged out / expired / revoked: the token is dead either way.
        await kv.delete(f"rt:{presented}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )
    profile_id_raw, current_hash = _split_sess(sess_value)
    if presented != current_hash:
        # REUSE DETECTION: a rotated (stale) token was replayed — revoke the
        # entire session: the session record plus the *current* refresh token,
        # and drop the sid from the profile's live-session index (ADR-0024).
        await kv.delete(f"sess:{sid}", f"rt:{current_hash}", f"rt:{presented}")
        await kv.srem(_user_sess_key(profile_id_raw), sid)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="session revoked"
        )

    try:
        profile_id = uuid.UUID(profile_id_raw)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        ) from None
    profile = await db.get(Profile, profile_id)
    if profile is None:
        await kv.delete(f"sess:{sid}", f"rt:{presented}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token"
        )

    # Rotate: the session now points at the new hash; the old rt entry is
    # deliberately retained as a tombstone for future reuse detection.
    refresh_raw, refresh_hash = new_refresh_token()
    await kv.setex(
        f"sess:{sid}", settings.refresh_ttl, _sess_value(profile_id_raw, refresh_hash)
    )
    await kv.setex(f"rt:{refresh_hash}", settings.refresh_ttl, sid)
    # Rotation mints a new refresh token but keeps the SAME sid, so the
    # index membership is unchanged; the idempotent SADD only refreshes the
    # index TTL so it never expires before the live sessions it lists.
    await kv.sadd(_user_sess_key(profile_id_raw), sid, ttl_seconds=settings.refresh_ttl)
    access = create_access_token(profile_id_raw, sid)
    return profile, access, refresh_raw


@router.post("/refresh-cookie", response_model=AuthOut | SessionProbeOut)
async def refresh_cookie(
    request: Request, response: Response, db: DbDep, kv: KvDep
) -> AuthOut | SessionProbeOut:
    """Rotate the refresh token carried in the ``kh_refresh`` httpOnly cookie.

    With a cookie present: identical semantics to ``POST /auth/refresh``
    (same KV keys, same reuse detection); the rotated token is returned in
    the body AND set as the new cookie (HttpOnly, Secure, SameSite=Lax,
    path=/api/v1/auth).

    Session probe (T14.1): a request carrying NO ``kh_refresh`` cookie at
    all answers 200 ``{"session": false}`` and sets no cookie — the web
    boot probes this endpoint whenever no cookie exists, and that expected
    empty state must not pollute devtools with 401s. A cookie that IS
    present but invalid/expired/revoked/reused still 401s exactly like the
    JSON transport.
    """
    await enforce_rate_limit(kv, request, None)
    presented_raw = request.cookies.get(REFRESH_COOKIE_NAME)
    if presented_raw is None:
        # Probe miss: no cookie, no side effects, no Set-Cookie header.
        return SessionProbeOut(session=False)
    profile, access, refresh_raw = await _rotate_refresh(kv, db, presented_raw)
    set_refresh_cookie(response, refresh_raw)
    return _auth_out(profile, access, refresh_raw)


@router.post("/logout-cookie", status_code=status.HTTP_204_NO_CONTENT)
async def logout_cookie(request: Request, response: Response, kv: KvDep) -> None:
    """Clear the refresh cookie and revoke the session it points at (204).

    Idempotent: a missing/unknown cookie still clears the cookie and answers
    204. Revocation mirrors ``POST /auth/logout`` (session record + current
    refresh token die together).
    """
    clear_refresh_cookie(response)
    presented_raw = request.cookies.get(REFRESH_COOKIE_NAME)
    if presented_raw is None:
        return
    presented = sha256_hex(presented_raw)
    sid = await kv.get(f"rt:{presented}")
    if sid is None:  # unknown/garbage cookie — nothing to revoke
        return
    sess_value = await kv.get(f"sess:{sid}")
    if sess_value is not None:
        profile_id, current_hash = _split_sess(sess_value)
        await kv.delete(f"sess:{sid}", f"rt:{current_hash}")
        await kv.srem(_user_sess_key(profile_id), sid)  # ADR-0024
    else:  # dead session: drop the stale tombstone too
        await kv.delete(f"sess:{sid}", f"rt:{presented}")


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(session: CurrentSession, kv: KvDep) -> None:
    """Revoke the caller's session and its current refresh token (204)."""
    profile, sid = session
    sess_value = await kv.get(f"sess:{sid}")
    if sess_value is not None:
        _, current_hash = _split_sess(sess_value)
        await kv.delete(f"sess:{sid}", f"rt:{current_hash}")
    else:  # pragma: no cover - defensive; get_current_session guarantees liveness
        await kv.delete(f"sess:{sid}")
    await kv.srem(_user_sess_key(str(profile.id)), sid)  # ADR-0024


@router.get("/me", response_model=UserOut)
async def me(session: CurrentSession) -> UserOut:
    """Return the authenticated user's public profile."""
    profile, _ = session
    return UserOut.model_validate(profile)


# --- session visibility + revocation (ADR-0024) -----------------------------


async def _scan_user_sessions(
    kv: KV, profile_id: str
) -> tuple[list[SessionItemOut], list[str]]:
    """Live sessions from the profile's index + stale members to prune.

    Returns ``(live, dead)``. ``live`` carries ``id``/``expires_in`` (from the
    KV TTL of ``sess:<sid>``) for every index member whose session record is
    alive AND belongs to this profile. ``dead`` collects members whose record
    is missing/expired (or foreign) — the caller must prune them from the
    index, since nothing else ever removes those entries.
    """
    items: list[SessionItemOut] = []
    dead: list[str] = []
    for sid in sorted(await kv.smembers(_user_sess_key(profile_id))):
        ttl = await kv.ttl(f"sess:{sid}")
        if ttl < 0:  # -2 missing (expired/revoked); -1 cannot occur (always setex'd)
            dead.append(sid)
            continue
        sess_value = await kv.get(f"sess:{sid}")
        if sess_value is None or _split_sess(sess_value)[0] != profile_id:
            dead.append(sid)  # defensive: never surface a foreign session
            continue
        items.append(SessionItemOut(id=sid, expires_in=ttl))
    return items, dead


@router.get("/sessions", response_model=SessionsOut)
async def list_sessions(session: LooseSession, kv: KvDep) -> SessionsOut:
    """List the caller's LIVE sessions, newest TTLs included (200).

    The per-user index is pruned of dead members on read, so the response
    only ever shows sessions that can actually still refresh. ``current`` is
    the ``sid`` claim of the caller's own access token (ADR-0002); ``null``
    when the token carries no ``sid`` claim (current session unknown).
    """
    profile, sid = session
    profile_id = str(profile.id)
    items, dead = await _scan_user_sessions(kv, profile_id)
    if dead:
        await kv.srem(_user_sess_key(profile_id), *dead)
    return SessionsOut(items=items, current=sid)


@router.post("/sessions/revoke-others", response_model=RevokeOthersOut)
async def revoke_other_sessions(session: LooseSession, kv: KvDep) -> RevokeOthersOut:
    """Revoke every live session of the caller EXCEPT the current one.

    Same teardown semantics as ``POST /auth/logout`` per victim session:
    ``sess:<sid>`` + its current ``rt:<hash>`` die together, and the sid is
    removed from the profile's index. Idempotent — with nothing else live it
    answers ``{"revoked": 0}``. 409 when the caller's token has no ``sid``
    claim (nothing is revoked: refusing beats guessing what to keep).
    """
    profile, sid = session
    if sid is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=_CURRENT_SESSION_UNKNOWN
        )
    profile_id = str(profile.id)
    revoked = 0
    others = [
        member
        for member in sorted(await kv.smembers(_user_sess_key(profile_id)))
        if member != sid
    ]
    for other in others:
        sess_value = await kv.get(f"sess:{other}")
        if sess_value is None or _split_sess(sess_value)[0] != profile_id:
            continue  # already dead — just pruned from the index below
        _, current_hash = _split_sess(sess_value)
        await kv.delete(f"sess:{other}", f"rt:{current_hash}")
        revoked += 1
    if others:
        await kv.srem(_user_sess_key(profile_id), *others)
    return RevokeOthersOut(revoked=revoked)
