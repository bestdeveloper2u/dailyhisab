"""Debt schemas (wire contract per ADR-0004).

Rules implemented here (do not drift):

* money is a decimal STRING with exactly 2 places ("2000.00") — never a JSON
  number; debt amounts must additionally be > 0 (mirrors the DB CHECK);
* JSON keys mirror DB columns: ``party``, ``dir``, ``amt``, ``note``, ``iso``
  (the ``iso`` column is the event *date*, not a currency — ADR-0004 §2);
* ``id``/``user_id`` are lowercase canonical uuid strings; ``settled_at`` /
  ``created_at`` are RFC 3339 UTC strings with ``Z``; nullable ``note`` and
  ``settled_at`` serialize explicitly as ``null``;
* ``dir`` is ``lend`` (I gave money out) or ``borrow`` (I owe money).
"""

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.schemas.expense import AmtStr, MoneyStr, Rfc3339Str, UidStr

DebtDirection = Literal["lend", "borrow"]

# numeric(12,2) with a CHECK (amt > 0): the string pattern pins the 2dp shape;
# the validator rejects the remaining zero case ("0.00").


def _require_positive(v: str) -> str:
    if Decimal(v) <= 0:
        raise ValueError("amt must be greater than 0")
    return v


PositiveAmt = Annotated[AmtStr, AfterValidator(_require_positive)]


class DebtIn(BaseModel):
    """POST /debts body. ``iso`` defaults to today (router fills it)."""

    party: str = Field(min_length=1, max_length=120)
    dir: DebtDirection
    amt: PositiveAmt
    note: str | None = Field(default=None, max_length=200)
    iso: date | None = None


class DebtUpdate(BaseModel):
    """PATCH /debts/{id} body — every field optional (partial update)."""

    party: str | None = Field(default=None, min_length=1, max_length=120)
    dir: DebtDirection | None = None
    amt: PositiveAmt | None = None
    note: str | None = Field(default=None, max_length=200)
    iso: date | None = None


class DebtOut(BaseModel):
    """Public debt row; keys mirror the DB columns exactly."""

    model_config = ConfigDict(from_attributes=True)

    id: UidStr
    user_id: UidStr
    party: str
    dir: DebtDirection
    amt: MoneyStr
    note: str | None = None
    iso: date
    settled_at: Rfc3339Str | None = None
    created_at: Rfc3339Str


class DebtListOut(BaseModel):
    """Envelope for GET /debts (ADR-0004 §8)."""

    items: list[DebtOut]
    next_cursor: str | None


class DebtPayIn(BaseModel):
    """POST /debts/{id}/pay body — the amount being paid back."""

    amt: PositiveAmt


class DebtPayOut(BaseModel):
    """Pay close-out result: FULL settles the debt, PARTIAL reduces it."""

    status: Literal["FULL", "PARTIAL"]
    debt: DebtOut
