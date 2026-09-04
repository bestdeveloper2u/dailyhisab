"""Password hashing (Argon2id) and JWT access-token helpers (HS256).

Per ADR-0002 (Phase 1 auth):
* passwords are hashed with Argon2id (argon2-cffi ``PasswordHasher``);
* access tokens are short-lived HS256 JWTs carrying ``sub`` (profile id),
  ``sid`` (session id), ``iat`` and ``exp``;
* refresh tokens are 256-bit urlsafe secrets; only their SHA-256 digest is
  ever stored in the KV store.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error

from app.core.config import Settings, get_settings

_hasher = PasswordHasher()

# Number of random bytes in a refresh token (256 bits of entropy).
_REFRESH_TOKEN_BYTES = 32


def hash_password(password: str) -> str:
    """Hash a plaintext password with Argon2id."""
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Constant-ish verify of ``password`` against an Argon2id hash."""
    if not password_hash:
        return False
    try:
        return _hasher.verify(password_hash, password)
    except Argon2Error:
        return False


_timing_dummy_hash: str | None = None


def dummy_verify(password: str) -> None:
    """Burn roughly the same CPU as a real verification (timing hygiene).

    Used on the "unknown email" path of login so that the response time does
    not reveal whether the account exists.
    """
    global _timing_dummy_hash
    if _timing_dummy_hash is None:
        _timing_dummy_hash = _hasher.hash("khoroch-timing-dummy")
    try:
        _hasher.verify(_timing_dummy_hash, password)
    except Argon2Error:
        pass


def sha256_hex(value: str) -> str:
    """Hex SHA-256 digest of a string (how refresh tokens are stored)."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_session_id() -> str:
    """Random session identifier stored in KV and embedded in access tokens."""
    return secrets.token_urlsafe(24)


def new_refresh_token() -> tuple[str, str]:
    """Return ``(raw_token, sha256_hex)`` for a fresh 256-bit refresh token."""
    raw = secrets.token_urlsafe(_REFRESH_TOKEN_BYTES)
    return raw, sha256_hex(raw)


def create_access_token(
    profile_id: str, session_id: str, ttl_seconds: int | None = None
) -> str:
    """Mint a short-lived HS256 access token for ``profile_id``/``session_id``."""
    settings: Settings = get_settings()
    ttl = settings.access_ttl if ttl_seconds is None else ttl_seconds
    now = datetime.now(UTC)
    claims: dict[str, Any] = {
        "sub": profile_id,
        "sid": session_id,
        "iat": now,
        "exp": now + timedelta(seconds=ttl),
    }
    token: str = jwt.encode(claims, settings.jwt_secret, algorithm="HS256")
    return token


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate an access token.

    Raises ``jwt.PyJWTError`` (bad signature, expired, malformed, ...) on any
    failure; callers translate that into 401.
    """
    claims: dict[str, Any] = jwt.decode(
        token, get_settings().jwt_secret, algorithms=["HS256"]
    )
    return claims
