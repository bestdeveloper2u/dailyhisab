"""Auth request/response schemas (camelCase wire format)."""

import uuid

from pydantic import BaseModel, ConfigDict, Field

# Pragmatic Phase 1 email check (full RFC validation is not the goal here;
# using EmailStr would drag in the email-validator dependency).
_EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class UserOut(BaseModel):
    """Public view of a profile."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str | None
    name: str


class AuthOut(BaseModel):
    """Login/register/refresh response: user + token pair."""

    model_config = ConfigDict(populate_by_name=True)

    user: UserOut
    access_token: str = Field(alias="accessToken")
    refresh_token: str = Field(alias="refreshToken")


class SessionProbeOut(BaseModel):
    """``POST /auth/refresh-cookie`` answer when the request carries NO
    ``kh_refresh`` cookie at all: there is no cookie session, so the endpoint
    answers 200 ``{"session": false}`` instead of 401 (keeps browser
    devtools/consoles free of *expected* 401 noise). A cookie that IS present
    but invalid/expired/revoked still 401s like the JSON transport."""

    session: bool


class RegisterIn(BaseModel):
    """POST /auth/register body."""

    email: str = Field(pattern=_EMAIL_PATTERN, min_length=3, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    name: str | None = Field(default=None, min_length=1, max_length=120)


class LoginIn(BaseModel):
    """POST /auth/login body."""

    email: str = Field(pattern=_EMAIL_PATTERN, min_length=3, max_length=255)
    password: str = Field(min_length=1, max_length=128)


class RefreshIn(BaseModel):
    """POST /auth/refresh body."""

    model_config = ConfigDict(populate_by_name=True)

    refresh_token: str = Field(alias="refreshToken", min_length=16, max_length=512)


class SessionItemOut(BaseModel):
    """One live session of the caller (GET /auth/sessions item).

    ``expires_in`` is the remaining KV TTL of ``sess:<id>`` in seconds —
    the same lifetime the refresh token has left.
    """

    id: str
    expires_in: int


class SessionsOut(BaseModel):
    """GET /auth/sessions response: the caller's live sessions.

    ``current`` is the session id embedded in the caller's own access token
    (``sid`` claim, ADR-0002). ``null`` means the token carried no ``sid``
    claim, so the current session cannot be pinpointed (revoke-others will
    refuse with 409 in that case).
    """

    items: list[SessionItemOut]
    current: str | None


class RevokeOthersOut(BaseModel):
    """POST /auth/sessions/revoke-others response."""

    revoked: int
