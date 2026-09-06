"""Recurring-expense rule schemas (wire contract per ADR-0004, ADR-0014).

Rules implemented here (do not drift):

* money is a decimal STRING with exactly 2 places ("2000.00") — never a JSON
  number; the DB CHECK (amt >= 0) mirrors ``expenses``, not ``debts``;
* JSON keys mirror DB columns: ``cat``, ``grp``, ``amt``, ``pay``, ``desc``,
  ``freq``, ``start_date``, ``next_run``, ``active`` (the ``description`` ORM
  attribute serializes as ``desc``);
* ``freq`` is ``daily`` | ``weekly`` | ``monthly`` | ``yearly``;
* ``start_date`` / ``next_run`` are plain ``YYYY-MM-DD`` dates;
  ``next_run`` is server-owned (forward-only materialization cursor,
  ADR-0014 §3) — it appears in responses but never in request bodies;
* ``id``/``user_id`` are lowercase canonical uuid strings; ``created_at`` /
  ``updated_at`` are RFC 3339 UTC strings with ``Z``; nullable ``desc``
  serializes explicitly as ``null``.
"""

from datetime import date
from typing import Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
)

from app.schemas.expense import (
    AmtStr,
    ExpenseGroup,
    ExpenseOut,
    MoneyStr,
    PayMethod,
    Rfc3339Str,
    UidStr,
)

Frequency = Literal["daily", "weekly", "monthly", "yearly"]


class RecurringIn(BaseModel):
    """POST /recurring body. ``start_date`` defaults to today (router fills)."""

    cat: str = Field(min_length=1, max_length=80)
    grp: ExpenseGroup
    amt: AmtStr
    pay: PayMethod = "cash"
    desc: str | None = Field(default=None, max_length=200)
    freq: Frequency
    start_date: date | None = None


class RecurringUpdate(BaseModel):
    """PATCH /recurring/{id} body — every field optional (partial update)."""

    cat: str | None = Field(default=None, min_length=1, max_length=80)
    grp: ExpenseGroup | None = None
    amt: AmtStr | None = None
    pay: PayMethod | None = None
    desc: str | None = Field(default=None, max_length=200)
    freq: Frequency | None = None
    start_date: date | None = None
    active: bool | None = None


class RecurringOut(BaseModel):
    """Public rule row; keys mirror the DB columns exactly."""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: UidStr
    user_id: UidStr
    cat: str
    grp: ExpenseGroup
    amt: MoneyStr
    pay: PayMethod
    # The ORM attribute is ``description`` (Column "desc") — accept both on
    # input, always serialize the column name ``desc`` on the wire.
    desc: str | None = Field(
        default=None,
        max_length=200,
        validation_alias=AliasChoices("desc", "description"),
    )
    freq: Frequency
    start_date: date
    next_run: date
    active: bool
    created_at: Rfc3339Str
    updated_at: Rfc3339Str


class RecurringListOut(BaseModel):
    """Envelope for GET /recurring (ADR-0004 §8)."""

    items: list[RecurringOut]
    next_cursor: str | None


class RecurringRunOut(BaseModel):
    """POST /recurring/run result: what THIS run materialized (ADR-0014 §4).

    ``created == len(expenses)``; ``rules`` is how many due rules were
    processed. A repeat run the same day returns ``created: 0`` — the
    idempotency guarantee.
    """

    ran_on: date
    created: int
    rules: int
    expenses: list[ExpenseOut]
