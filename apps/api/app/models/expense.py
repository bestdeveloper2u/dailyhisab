"""expenses table.

Column names mirror the DB exactly (``cat``, ``grp``, ``amt``, ``pay``,
``desc``, ``iso``) so API JSON matches the columns (ADR-0004). The reserved
word ``desc`` is exposed as the Python attribute ``description`` mapped to
Column("desc", ...) — see docs/adr/0005-database-portability.md.

UUIDs default to Python-side ``uuid4`` (client-generated keys, portable
across sqlite/postgres — gen_random_uuid() is PG13+ only).
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
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import GUID


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    cat: Mapped[str] = mapped_column(Text, nullable=False)
    grp: Mapped[str] = mapped_column(Text, nullable=False)
    amt: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    pay: Mapped[str] = mapped_column(Text, nullable=False, default="cash")
    description: Mapped[str | None] = mapped_column("desc", Text)
    iso: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("amt >= 0", name="amt_nonneg"),
        Index("expenses_user_iso", "user_id", text("iso DESC")),
    )
