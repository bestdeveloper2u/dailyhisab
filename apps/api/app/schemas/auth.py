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
