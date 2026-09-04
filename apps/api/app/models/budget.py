"""budgets table.

``cats`` is a JSON mapping on SQLite and JSONB on PostgreSQL (JSONVariant).
``updated_at`` bumps automatically on UPDATE via ``onupdate=func.now()``.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Numeric, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import GUID, JSONVariant

DEFAULT_BUDGET_TOTAL = Decimal("20000.00")


class Budget(Base):
    __tablename__ = "budgets"

    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    total: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=DEFAULT_BUDGET_TOTAL
    )
    cats: Mapped[dict[str, Any]] = mapped_column(JSONVariant(), nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
