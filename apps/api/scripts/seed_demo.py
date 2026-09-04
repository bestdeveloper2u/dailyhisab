"""Idempotent demo seed: demo@khoroch.app / demo1234 (Argon2id).

Run AFTER migrations (the schema must exist):

    alembic upgrade head
    uv run python scripts/seed_demo.py

Uses a *synchronous* sessionmaker against KHOROCH_DATABASE_URL so it works
both on PostgreSQL and on a plain SQLite file (the async driver suffix is
translated automatically).
"""

import uuid

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.models.profile import DEMO_USER_NAME, Profile

DEMO_EMAIL = "demo@khoroch.app"
DEMO_PASSWORD = "demo1234"

# Deterministic id so repeated seeds across environments line up.
DEMO_ID = uuid.uuid5(uuid.NAMESPACE_URL, "khoroch:demo-user")


def to_sync_url(url: str) -> str:
    """Translate an async SQLAlchemy URL to its sync equivalent."""
    if url.startswith("sqlite+aiosqlite"):
        return url.replace("sqlite+aiosqlite", "sqlite", 1)
    if url.startswith("postgresql+asyncpg"):
        return url.replace("postgresql+asyncpg", "postgresql+psycopg2", 1)
    return url


def main() -> None:
    settings = get_settings()
    engine = create_engine(to_sync_url(settings.database_url))
    factory = sessionmaker(bind=engine)
    with factory() as session:
        session: Session  # (narrow the type for readability below)
        profile = session.scalar(select(Profile).where(Profile.email == DEMO_EMAIL))
        if profile is None:
            profile = Profile(
                id=DEMO_ID,
                name=DEMO_USER_NAME,
                email=DEMO_EMAIL,
                lang="bn",
                theme="light",
                password_hash=hash_password(DEMO_PASSWORD),
            )
            session.add(profile)
            session.commit()
            print(f"created demo profile {profile.id} ({DEMO_EMAIL})")
        elif not verify_password(profile.password_hash, DEMO_PASSWORD):
            profile.password_hash = hash_password(DEMO_PASSWORD)
            session.commit()
            print(f"reset password for demo profile {profile.id} ({DEMO_EMAIL})")
        else:
            print(f"demo profile {profile.id} ({DEMO_EMAIL}) already up to date")
    engine.dispose()


if __name__ == "__main__":
    main()
