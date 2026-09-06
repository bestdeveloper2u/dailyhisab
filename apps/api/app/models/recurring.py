"""recurring_expenses table (T16.1, ADR-0014).

A rule ("বিবি's tuition, 2000.00, monthly, from 2026-09-10") that the
materialization run (``POST /recurring/run``) turns into real ``expenses``
rows. The payload columns mirror ``expenses`` exactly (``cat``/``grp``/
``amt``/``pay``/``desc``) so materialization is a column-for-column copy and
the wire stays a mechanical ADR-0004 mapping. Like :class:`app.models.expense.
Expense`, the reserved word ``desc`` is the Python attribute ``description``,
and UUIDs default to Python-side ``uuid4`` (portable across sqlite/postgres).

``next_run`` is the *idempotency cursor*: the earliest occurrence date that
has NOT been materialized yet. It only ever moves forward — create sets it to
``start_date``, the run advances it past ``today``, PATCH never rewinds it
(see :mod:`app.routers.recurring`) — so running the materialization twice can
never insert the same occurrence twice.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
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


class RecurringExpense(Base):
    __tablename__ = "recurring_expenses"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    cat: Mapped[str] = mapped_column(Text, nullable=False)
    grp: Mapped[str] = mapped_column(Text, nullable=False)
    amt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    pay: Mapped[str] = mapped_column(Text, nullable=False, default="cash")
    description: Mapped[str | None] = mapped_column("desc", Text)
    freq: Mapped[str] = mapped_column(Text, nullable=False)
    # ``start_date`` is the first occurrence of the rule; ``next_run`` is the
    # materialization cursor (server-owned, forward-only — ADR-0014 §3).
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    next_run: Mapped[date] = mapped_column(Date, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        CheckConstraint("amt >= 0", name="amt_nonneg"),
        CheckConstraint(
            "freq IN ('daily', 'weekly', 'monthly', 'yearly')", name="freq_valid"
        ),
        # The run query: WHERE user_id = ? AND active AND next_run <= today.
        Index("recurring_user_next", "user_id", "next_run"),
    )
