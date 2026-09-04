"""profiles table.

NOTE (Phase 1, no Supabase Auth): ``profiles.id`` is a plain uuid PK here.
The Supabase draft (deploy/supabase-schema.sql) references ``auth.users`` and
enables RLS; our backend manages identity at the API layer instead.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import GUID

DEMO_USER_NAME = "ডেমো ব্যবহারকারী"


class Profile(Base):
    __tablename__ = "profiles"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False, default=DEMO_USER_NAME)
    email: Mapped[str | None] = mapped_column(Text)
    # Argon2id hash (app.core.security.hash_password); NULL for legacy rows
    # that have never had a password set (added in migration 0002).
    password_hash: Mapped[str | None] = mapped_column(Text)
    lang: Mapped[str] = mapped_column(Text, nullable=False, default="bn")
    theme: Mapped[str] = mapped_column(Text, nullable=False, default="light")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("lang IN ('bn', 'en')", name="lang_valid"),
        CheckConstraint("theme IN ('light', 'dark')", name="theme_valid"),
    )
