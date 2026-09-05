"""T15.3 full-fidelity JSON backup + restore (ADR-0012).

``GET /export/backup.json`` dumps the caller's COMPLETE ledger — every
expenses/debts/budgets column — as one versioned envelope (money stays exact
2dp decimal strings per ADR-0004). ``POST /import/restore`` accepts the same
envelope and REPLACEs the caller's data: v1 is deliberately
replace-not-merge (expenses have no dedup keys, so a merge would be
unpredictable — ADR-0012).

Restore swaps everything in ONE transaction: the caller's expenses, debts
and budgets rows are deleted and the uploaded rows inserted with FRESH
primary keys — ``id``/``user_id`` from the file are never trusted (rows land
under the authenticated user, IDOR-safe like the rest of the API). Any
validation or insert failure rolls the whole restore back.

Both endpoints are user-scoped via :data:`app.core.deps.get_current_user`
(401 without a valid Bearer token). Restore validation is done manually with
pydantic :class:`~app.schemas.backup.RestoreIn` (``model_validate``) so every
invalid envelope — schema_version ≠ 1, negative amounts, bad enums, malformed
dates — comes back as the house bn/en error triple (ADR-0004 §7), not a bare
FastAPI validation array.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.budget import Budget
from app.models.debt import Debt
from app.models.expense import Expense
from app.models.profile import Profile
from app.schemas.backup import (
    BACKUP_SCHEMA_VERSION,
    BackupBudgetRow,
    BackupCounts,
    BackupEnvelope,
    RestoreBudgetRow,
    RestoreDebtRow,
    RestoreExpenseRow,
    RestoreIn,
    RestoreOut,
)
from app.schemas.debt import DebtOut
from app.schemas.expense import ExpenseOut

export_router = APIRouter(prefix="/export", tags=["export"])
import_router = APIRouter(prefix="/import", tags=["import"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

_TWO_PLACES = Decimal("0.01")

_UNSUPPORTED_VERSION = {
    "code": "unsupported_backup_version",
    "message_bn": "ব্যাকআপের স্কিমা সংস্করণ সমর্থিত নয়; শুধু সংস্করণ 1 গ্রহণযোগ্য",
    "message_en": "Unsupported backup schema_version; only version 1 is accepted",
}
_BAD_ROW = {
    "code": "invalid_backup_row",
    "message_bn": "ব্যাকআপ ফাইলে একটি অবৈধ সারি আছে",
    "message_en": "The backup file contains an invalid row",
}
_BAD_ENVELOPE = {
    "code": "invalid_backup",
    "message_bn": "ব্যাকআপ ফাইলের গঠন অবৈধ",
    "message_en": "The backup file envelope is invalid",
}


def _money(value: Decimal) -> str:
    return str(value.quantize(_TWO_PLACES))


def _rfc3339(value: datetime) -> str:
    """RFC 3339 UTC with trailing ``Z``; naive values are assumed UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


# --- GET /export/backup.json -------------------------------------------------


@export_router.get("/backup.json", response_model=BackupEnvelope)
async def export_backup_json(
    response: Response, db: DbDep, user: CurrentUser
) -> BackupEnvelope:
    """Dump the caller's complete ledger as one JSON envelope (ADR-0012).

    Every column of every expenses/debts/budgets row; rows are ordered
    deterministically (``iso ASC, id ASC`` — the CSV export's order) so the
    same data always yields the same document modulo ``exported_at``.
    """
    expense_rows = (
        await db.scalars(
            select(Expense)
            .where(Expense.user_id == user.id)
            .order_by(Expense.iso, Expense.id)
        )
    ).all()
    debt_rows = (
        await db.scalars(
            select(Debt).where(Debt.user_id == user.id).order_by(Debt.iso, Debt.id)
        )
    ).all()
    budget = await db.get(Budget, user.id)  # PK is user_id → 0 or 1 row
    budget_rows = (
        [
            BackupBudgetRow(
                user_id=str(budget.user_id),
                total=_money(Decimal(str(budget.total))),
                cats={
                    str(cat): _money(Decimal(str(value)))
                    for cat, value in (budget.cats or {}).items()
                },
                updated_at=_rfc3339(budget.updated_at),
            )
        ]
        if budget is not None
        else []
    )
    envelope = BackupEnvelope(
        schema_version=BACKUP_SCHEMA_VERSION,
        exported_at=_rfc3339(datetime.now(UTC)),
        counts=BackupCounts(
            expenses=len(expense_rows), debts=len(debt_rows), budgets=len(budget_rows)
        ),
        expenses=[ExpenseOut.model_validate(row) for row in expense_rows],
        debts=[DebtOut.model_validate(row) for row in debt_rows],
        budgets=budget_rows,
    )
    today = datetime.now(UTC).date()
    response.headers["Content-Disposition"] = (
        f'attachment; filename="backup-{today:%Y%m%d}.json"'
    )
    return envelope


# --- POST /import/restore ----------------------------------------------------


def _restore_error(exc: ValidationError) -> dict[str, str]:
    """Map the first pydantic failure onto a house bn/en error triple."""
    top = exc.errors()[0]["loc"][:1]
    if top == ("schema_version",):
        return _UNSUPPORTED_VERSION
    if top and top[0] in ("expenses", "debts", "budgets"):
        return _BAD_ROW
    return _BAD_ENVELOPE


def _expense_row(user_id: uuid.UUID, row: RestoreExpenseRow) -> Expense:
    """Build one INSERT with a fixed field order; the PK stays fresh."""
    expense = Expense(
        user_id=user_id,
        cat=row.cat,
        grp=row.grp,
        amt=Decimal(row.amt),
        pay=row.pay,
        description=row.desc,
        iso=row.iso,
    )
    if row.created_at is not None:
        expense.created_at = row.created_at
    return expense


def _debt_row(user_id: uuid.UUID, row: RestoreDebtRow) -> Debt:
    """Build one INSERT with a fixed field order; the PK stays fresh."""
    debt = Debt(
        user_id=user_id,
        party=row.party,
        dir=row.dir,
        amt=Decimal(row.amt),
        note=row.note,
        iso=row.iso,
    )
    if row.settled_at is not None:
        debt.settled_at = row.settled_at
    if row.created_at is not None:
        debt.created_at = row.created_at
    return debt


def _budget_row(user_id: uuid.UUID, row: RestoreBudgetRow) -> Budget:
    budget = Budget(user_id=user_id, total=Decimal(row.total), cats=dict(row.cats))
    if row.updated_at is not None:
        budget.updated_at = row.updated_at
    return budget


@import_router.post("/restore", response_model=RestoreOut)
async def import_restore(
    body: Annotated[
        dict[str, Any],
        Body(description="A GET /export/backup.json envelope (schema_version 1)."),
    ],
    db: DbDep,
    user: CurrentUser,
) -> RestoreOut:
    """REPLACE the caller's ledger with the uploaded backup (v1, ADR-0012).

    The whole swap is one transaction: delete the caller's budgets, debts and
    expenses, insert the uploaded rows with fresh PKs, commit. Rows whose
    validation fails never reach the database; a failure mid-insert rolls
    the deletes back too.
    """
    try:
        envelope = RestoreIn.model_validate(body)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_restore_error(exc),
        ) from None

    budgets = [_budget_row(user.id, row) for row in envelope.budgets]
    debts = [_debt_row(user.id, row) for row in envelope.debts]
    expenses = [_expense_row(user.id, row) for row in envelope.expenses]

    try:
        # One transaction: get_current_user already autobegan this session's
        # transaction (the profile SELECT), so these statements plus the
        # commit below are a single atomic unit.
        await db.execute(delete(Budget).where(Budget.user_id == user.id))
        await db.execute(delete(Debt).where(Debt.user_id == user.id))
        await db.execute(delete(Expense).where(Expense.user_id == user.id))
        db.add_all(budgets)
        db.add_all(debts)
        db.add_all(expenses)
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return RestoreOut(
        restored=BackupCounts(
            expenses=len(expenses), debts=len(debts), budgets=len(budgets)
        )
    )
