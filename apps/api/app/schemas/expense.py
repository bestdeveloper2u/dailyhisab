"""Expense, voice-parse and report schemas (wire contract per ADR-0004).

Rules implemented here (do not drift):

* money is a decimal STRING with exactly 2 places ("890.00") — never a JSON
  number, never integer paisa;
* JSON keys mirror DB columns: ``cat``, ``grp``, ``amt``, ``pay``, ``desc``,
  ``iso`` (the ``description`` ORM attribute serializes as ``desc``);
* ``id``/``user_id`` are lowercase canonical uuid strings; ``created_at`` is
  an RFC 3339 UTC string with ``Z``;
* nullable ``desc`` serializes explicitly as ``null``.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
)

ExpenseGroup = Literal[
    "food",
    "housing",
    "utility",
    "transport",
    "health",
    "education",
    "personal",
    "other",
]
PayMethod = Literal["cash", "bkash", "nagad", "rocket", "card", "bank"]

# numeric(12,2): up to 10 integer digits + exactly 2 fraction digits, >= 0.
# A str-only pattern keeps JSON numbers out (ADR-0004 §1) and negatives out.
AmtStr = Annotated[str, Field(pattern=r"^\d{1,10}\.\d{2}$", examples=["890.00"])]

_TWO_PLACES = Decimal("0.01")
_UTC = UTC


def _to_uuid_str(v: object) -> object:
    """Lowercase canonical uuid string (ADR-0004 §5)."""
    if isinstance(v, uuid.UUID):
        return str(v)
    return v


def _money_str(v: object) -> object:
    """Quantize a Decimal amount to exactly 2 places for the wire."""
    if isinstance(v, Decimal):
        return str(v.quantize(_TWO_PLACES))
    if isinstance(v, float):  # defensive: sqlite round-trips
        return str(Decimal(str(v)).quantize(_TWO_PLACES))
    return v


def _rfc3339(v: object) -> object:
    """RFC 3339 UTC with trailing ``Z`` (naive datetimes are assumed UTC)."""
    if isinstance(v, datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=_UTC)
        return v.astimezone(_UTC).isoformat().replace("+00:00", "Z")
    return v


UidStr = Annotated[str, BeforeValidator(_to_uuid_str)]
MoneyStr = Annotated[str, BeforeValidator(_money_str)]
Rfc3339Str = Annotated[str, BeforeValidator(_rfc3339)]


class ExpenseIn(BaseModel):
    """POST /expenses and POST /expenses/bulk item body."""

    cat: str = Field(min_length=1, max_length=80)
    grp: ExpenseGroup
    amt: AmtStr
    pay: PayMethod = "cash"
    desc: str | None = Field(default=None, max_length=200)
    iso: date


class ExpenseUpdate(BaseModel):
    """PATCH /expenses/{id} body — every field optional (partial update)."""

    cat: str | None = Field(default=None, min_length=1, max_length=80)
    grp: ExpenseGroup | None = None
    amt: AmtStr | None = None
    pay: PayMethod | None = None
    desc: str | None = Field(default=None, max_length=200)
    iso: date | None = None


class ExpenseOut(BaseModel):
    """Public expense row; keys mirror the DB columns exactly."""

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
    iso: date
    created_at: Rfc3339Str


class ExpenseListOut(BaseModel):
    """Envelope for every list endpoint (ADR-0004 §8)."""

    items: list[ExpenseOut]
    next_cursor: str | None


class BulkExpensesIn(BaseModel):
    """POST /expenses/bulk body (voice multi-item inserts)."""

    items: list[ExpenseIn] = Field(min_length=1, max_length=50)


class BulkExpensesOut(BaseModel):
    items: list[ExpenseOut]


class KhataOut(BaseModel):
    """One distinct khata (category) derived from the caller's history.

    ``grp``/``last_used`` come from the khata's *most recent* expense and are
    prefill hints only — reports/budgets keep grouping each expense row by its
    own ``grp`` (ADR-0019).
    """

    cat: str
    grp: ExpenseGroup
    use_count: int = Field(ge=1)
    last_used: date


class KhataListOut(BaseModel):
    """Envelope for GET /expenses/categories (ADR-0004 §8; cursor always null)."""

    items: list[KhataOut]
    next_cursor: str | None = None


class VoiceParseIn(BaseModel):
    """POST /voice/parse body."""

    text: str = Field(min_length=1, max_length=500)


class ParsedItem(BaseModel):
    """One expense candidate extracted from a transcript segment."""

    cat: str
    grp: ExpenseGroup
    amt: str
    pay: PayMethod | None = None
    desc: str | None = None
    iso: date | None = None


class VoiceParseOut(BaseModel):
    items: list[ParsedItem]
    confidence: float = Field(ge=0.0, le=1.0)


class ReportByDay(BaseModel):
    iso: date
    total: str


class ReportByMonth(BaseModel):
    ym: str
    total: str


class MonthlyReportOut(BaseModel):
    ym: str
    total: str
    count: int
    by_group: dict[str, str]
    by_day: list[ReportByDay]


class YearlyReportOut(BaseModel):
    year: int
    total: str
    count: int
    by_group: dict[str, str]
    by_month: list[ReportByMonth]
