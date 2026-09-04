"""Shared FastAPI dependencies: the KV handle and the current-user resolver."""

import uuid
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.kv import KV, get_kv
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.profile import Profile

_bearer = HTTPBearer(auto_error=False)


def get_kv_dep() -> KV:
    """FastAPI dependency returning the process-wide KV backend."""
    return get_kv()


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_session(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[AsyncSession, Depends(get_db)],
    kv: Annotated[KV, Depends(get_kv_dep)],
) -> tuple[Profile, str]:
    """Resolve ``Authorization: Bearer <access>`` to ``(profile, session_id)``.

    Any failure — missing/malformed header, bad signature, expired token,
    unknown subject, revoked session — yields a uniform 401.
    """
    if credentials is None or not credentials.credentials:
        raise _unauthorized("Not authenticated")
    try:
        claims = decode_access_token(credentials.credentials)
    except jwt.PyJWTError:
        raise _unauthorized("Invalid or expired access token") from None
    sub = claims.get("sub")
    sid = claims.get("sid")
    if not isinstance(sub, str) or not isinstance(sid, str):
        raise _unauthorized("Invalid access token claims")
    try:
        profile_id = uuid.UUID(sub)
    except ValueError:
        raise _unauthorized("Invalid access token claims") from None
    if not await kv.exists(f"sess:{sid}"):
        raise _unauthorized("Session revoked")
    profile = await db.get(Profile, profile_id)
    if profile is None:
        raise _unauthorized("Unknown user")
    return profile, sid


async def get_current_user(
    session: Annotated[tuple[Profile, str], Depends(get_current_session)],
) -> Profile:
    """Return the authenticated profile (ignores which session it came from)."""
    return session[0]
