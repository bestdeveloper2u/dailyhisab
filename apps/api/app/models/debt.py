"""debts table.

Party model stays per-entry (lend/borrow), as in the Supabase draft.
``iso`` defaults to Python ``date.today`` — portable across backends, unlike
``current_date()`` server defaults (see ADR-0005).
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import GUID


class Debt(Base):
    __tablename__ = "debts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    party: Mapped[str] = mapped_column(Text, nullable=False)
    dir: Mapped[str] = mapped_column(Text, nullable=False)
    amt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    iso: Mapped[date] = mapped_column(Date, nullable=False, default=date.today)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("dir IN ('lend', 'borrow')", name="dir_valid"),
        CheckConstraint("amt > 0", name="amt_positive"),
        Index("debts_user", "user_id", "party"),
    )
