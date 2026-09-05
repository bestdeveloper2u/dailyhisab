"""Backup / restore envelope schemas (T15.3, ADR-0012).

``GET /export/backup.json`` returns the caller's COMPLETE ledger as ONE JSON
document; ``POST /import/restore`` accepts the same document and REPLACEs the
caller's ledger with it (v1 is deliberately replace-not-merge — ADR-0012).

House rules carried over from ADR-0004 (do not drift):

* money is a decimal STRING with exactly 2 places ("50.50") — never a JSON
  number;
* JSON keys mirror the DB columns; timestamps are RFC 3339 UTC with ``Z``;
* ``schema_version`` gates the envelope format so future evolution is
  explicit: readers reject unknown versions with 422 instead of guessing.

Restore rows keep the export row shape but only require the LEDGER content:
``id``/``user_id`` in the file are ignored (fresh PKs, rows land under the
calling user), while ``created_at`` / ``settled_at`` / ``updated_at`` are
preserved when present so list ordering and settle status survive a restore.
"""

from datetime import UTC, date, datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from app.schemas.budget import BudgetCats, cap_categories
from app.schemas.debt import DebtDirection, DebtOut, PositiveAmt
from app.schemas.expense import (
    AmtStr,
    ExpenseGroup,
    ExpenseOut,
    MoneyStr,
    PayMethod,
    Rfc3339Str,
    UidStr,
)

#: The only envelope version this build reads or writes (ADR-0012 §4).
BACKUP_SCHEMA_VERSION: Literal[1] = 1

#: Abuse guard: a restore may carry at most this many rows per collection.
MAX_BACKUP_ROWS = 10_000


def _as_utc(v: datetime | None) -> datetime | None:
    """Normalize an uploaded timestamp to UTC.

    The SQLite dev/test backend drops the tz offset at storage time, so a
    ``+06:00`` wall time stored as-is would silently shift the instant.
    Our exports always emit ``Z``; this only matters for hand-edited files.
    """
    if v is not None and v.tzinfo is not None:
        return v.astimezone(UTC)
    return v


UtcStamp = Annotated[datetime | None, AfterValidator(_as_utc)]


# --- export / document side --------------------------------------------------


class BackupCounts(BaseModel):
    """Row counts, mirroring the three collections of the same envelope."""

    expenses: int
    debts: int
    budgets: int


class BackupBudgetRow(BaseModel):
    """One budgets row (at most one per user — the PK is ``user_id``)."""

    model_config = ConfigDict(from_attributes=True)

    user_id: UidStr
    total: MoneyStr
    cats: dict[str, str]
    updated_at: Rfc3339Str


class BackupEnvelope(BaseModel):
    """The full-fidelity backup document (both directions, ADR-0012).

    ``expenses``/``debts`` reuse :class:`ExpenseOut`/:class:`DebtOut`, so the
    backup wire shape IS the CRUD wire shape (every column, money as exact
    decimal strings) — a downloaded file can be fed straight back to
    ``POST /import/restore``.
    """

    schema_version: Literal[1] = BACKUP_SCHEMA_VERSION
    exported_at: Rfc3339Str
    counts: BackupCounts
    expenses: list[ExpenseOut]
    debts: list[DebtOut]
    budgets: list[BackupBudgetRow]


# --- restore side ------------------------------------------------------------


class RestoreExpenseRow(BaseModel):
    """One uploaded expense row, validated like POST /expenses.

    ``created_at`` is optional and preserved when present (keyset ordering
    survives a restore); the fresh PK and the caller's ``user_id`` are
    assigned by the server regardless of what the file says.
    """

    cat: str = Field(min_length=1, max_length=80)
    grp: ExpenseGroup
    amt: AmtStr
    pay: PayMethod = "cash"
    desc: str | None = Field(default=None, max_length=200)
    iso: date
    created_at: UtcStamp = None


class RestoreDebtRow(BaseModel):
    """One uploaded debt row, validated like POST /debts.

    Unlike POST /debts, ``iso`` is REQUIRED (a backup always carries the
    event date — defaulting it to "today" would corrupt history).
    """

    party: str = Field(min_length=1, max_length=120)
    dir: DebtDirection
    amt: PositiveAmt
    note: str | None = Field(default=None, max_length=200)
    iso: date
    settled_at: UtcStamp = None
    created_at: UtcStamp = None


class RestoreBudgetRow(BaseModel):
    """The uploaded budgets row — at most one is accepted (PK is ``user_id``)."""

    total: AmtStr
    cats: BudgetCats = Field(default_factory=dict)
    updated_at: UtcStamp = None

    @field_validator("cats")
    @classmethod
    def _cap_category_count(cls, cats: dict[str, str]) -> dict[str, str]:
        return cap_categories(cats)


class RestoreIn(BaseModel):
    """POST /import/restore body — the same envelope as the backup export.

    All three collections default to empty (a minimal envelope therefore
    means "wipe me", which is exactly v1 REPLACE semantics). ``exported_at``
    is accepted but not interpreted.
    """

    schema_version: Literal[1] = BACKUP_SCHEMA_VERSION
    exported_at: str | None = None
    expenses: list[RestoreExpenseRow] = Field(
        default_factory=list, max_length=MAX_BACKUP_ROWS
    )
    debts: list[RestoreDebtRow] = Field(
        default_factory=list, max_length=MAX_BACKUP_ROWS
    )
    budgets: list[RestoreBudgetRow] = Field(default_factory=list, max_length=1)


class RestoreOut(BaseModel):
    """POST /import/restore response."""

    restored: BackupCounts
