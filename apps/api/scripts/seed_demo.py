"""Idempotent demo seed: demo@khoroch.app / demo1234 (Argon2id) + a set of
demo expenses for the dashboard/reports.

Run AFTER migrations (the schema must exist):

    alembic upgrade head
    uv run python scripts/seed_demo.py

Expenses use fixed uuid5 ids and are re-seeded (delete-then-insert for the
demo user only), so the script is safe to run repeatedly. Expense dates are
relative to *today* (spread over ~35 days) so the current and previous month
always have data. Uses a *synchronous* sessionmaker against
KHOROCH_DATABASE_URL so it works both on PostgreSQL and on a plain SQLite
file (the async driver suffix is translated automatically).
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.core.security import hash_password, verify_password
from app.models.expense import Expense
from app.models.profile import DEMO_USER_NAME, Profile

DEMO_EMAIL = "demo@khoroch.app"
DEMO_PASSWORD = "demo1234"

# Deterministic ids so repeated seeds across environments line up.
DEMO_ID = uuid.uuid5(uuid.NAMESPACE_URL, "khoroch:demo-user")
NS_EXPENSE = uuid.NAMESPACE_URL

# (days_ago, cat, grp, amt, pay, desc) — ~14 rows across current + last month.
DEMO_EXPENSES: list[tuple[int, str, str, str, str, str | None]] = [
    (0, "চা", "food", "30.00", "cash", "চা ও পরোটা"),
    (1, "রিকশা", "transport", "40.00", "cash", None),
    (2, "কাঁচাবাজার", "food", "890.00", "bkash", "সপ্তাহের বাজার"),
    (4, "বিজলি বিল", "utility", "1200.00", "bkash", None),
    (5, "ওষুধ", "health", "250.00", "cash", None),
    (6, "বাসা ভাড়া", "housing", "8000.00", "bank", "মাসিক ভাড়া"),
    (8, "মোবাইল রিচার্জ", "personal", "100.00", "bkash", None),
    (10, "টিউশন ফি", "education", "1500.00", "cash", None),
    (12, "কফি", "food", "120.50", "card", None),
    (15, "গ্যাস", "utility", "1080.00", "cash", None),
    (20, "জুতা", "personal", "1450.00", "card", None),
    (25, "উবার", "transport", "320.00", "card", None),
    (30, "অন্যান্য", "other", "200.00", "cash", "বিবিধ খরচ"),
    (33, "বই", "education", "1000.00", "cash", None),
]


def to_sync_url(url: str) -> str:
    """Translate an async SQLAlchemy URL to its sync equivalent."""
    if url.startswith("sqlite+aiosqlite"):
        return url.replace("sqlite+aiosqlite", "sqlite", 1)
    if url.startswith("postgresql+asyncpg"):
        return url.replace("postgresql+asyncpg", "postgresql+psycopg2", 1)
    return url


def _demo_expenses(profile_id: uuid.UUID, today: date) -> list[Expense]:
    expenses: list[Expense] = []
    for days_ago, cat, grp, amt, pay, desc in DEMO_EXPENSES:
        expenses.append(
            Expense(
                id=uuid.uuid5(NS_EXPENSE, f"khoroch:demo-expense:{days_ago}"),
                user_id=profile_id,
                cat=cat,
                grp=grp,
                amt=Decimal(amt),
                pay=pay,
                description=desc,
                iso=today - timedelta(days=days_ago),
            )
        )
    return expenses


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

        # Expenses: idempotent re-seed (delete the demo user's rows first).
        session.execute(delete(Expense).where(Expense.user_id == profile.id))
        fresh = _demo_expenses(profile.id, datetime.now(UTC).date())
        session.add_all(fresh)
        session.commit()
        print(f"seeded {len(fresh)} demo expenses for {profile.id}")
    engine.dispose()


if __name__ == "__main__":
    main()
