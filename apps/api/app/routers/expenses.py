"""Phase 2 expenses CRUD: list (keyset cursor pagination), create, bulk,
patch, delete. Every endpoint is scoped to the authenticated user via
:meth:`app.core.deps.get_current_user` and invalidates the report cache
(:mod:`app.routers.reports`) for the months/years its rows touch.

Cursor pagination (ADR-0004 §8): the cursor is the opaque base64url of
``"<iso>|<id>"`` — the last row of the previous page. Listing uses keyset
pagination with tuple comparison ``(iso, id) < (cursor_iso, cursor_id)``
under ``ORDER BY iso DESC, id DESC`` (matches the ``expenses_user_iso``
index; row-value comparison works on SQLite >= 3.15 and PostgreSQL).
"""

import base64
import binascii
import uuid
from collections.abc import Iterable
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_kv_dep
from app.core.kv import KV
from app.db.session import get_db
from app.models.expense import Expense
from app.models.profile import Profile
from app.schemas.expense import (
    BulkExpensesIn,
    BulkExpensesOut,
    ExpenseIn,
    ExpenseListOut,
    ExpenseOut,
    ExpenseUpdate,
)

router = APIRouter(prefix="/expenses", tags=["expenses"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
KvDep = Annotated[KV, Depends(get_kv_dep)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

# ExpenseUpdate uses the wire name; the ORM attribute is ``description``.
_UPDATE_FIELD_MAP = {"desc": "description"}

_NOT_FOUND = {
    "code": "not_found",
    "message_bn": "খরচটি খুঁজে পাওয়া যায়নি",
    "message_en": "Expense not found",
}
_INVALID_CURSOR = {
    "code": "invalid_cursor",
    "message_bn": "পেজিনেশন কার্সারটি অবৈধ",
    "message_en": "Invalid pagination cursor",
}


# --- report cache invalidation --------------------------------------------


def _report_cache_keys(user_id: str, dates: Iterable[date]) -> list[str]:
    """Monthly + yearly report keys touched by the given expense dates."""
    keys: list[str] = []
    seen: set[str] = set()
    for d in dates:
        ym = f"{d.year:04d}-{d.month:02d}"
        for key in (f"rep:monthly:{user_id}:{ym}", f"rep:yearly:{user_id}:{d.year}"):
            if key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


async def _invalidate_reports(kv: KV, user_id: uuid.UUID | str, dates: Iterable[date]) -> None:
    keys = _report_cache_keys(str(user_id), dates)
    if keys:
        await kv.delete(*keys)


# --- cursor helpers ---------------------------------------------------------


def _encode_cursor(expense: Expense) -> str:
    raw = f"{expense.iso.isoformat()}|{expense.id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[date, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        iso_raw, sep, id_raw = raw.decode("utf-8").partition("|")
        if not sep:
            raise ValueError("cursor missing separator")
        return date.fromisoformat(iso_raw), uuid.UUID(id_raw)
    except (ValueError, binascii.Error, UnicodeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_INVALID_CURSOR
        ) from None


# --- shared query pieces ----------------------------------------------------


async def _get_owned(db: AsyncSession, user: Profile, expense_id: uuid.UUID) -> Expense:
    """Fetch the expense only if it belongs to ``user`` (404 otherwise)."""
    expense = await db.scalar(
        select(Expense).where(Expense.id == expense_id, Expense.user_id == user.id)
    )
    if expense is None:
        # Unknown id OR another user's id: identical 404, never leak existence.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return expense


# --- endpoints --------------------------------------------------------------


@router.get("", response_model=ExpenseListOut)
async def list_expenses(
    db: DbDep,
    user: CurrentUser,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    q: Annotated[str | None, Query(min_length=1, max_length=80)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> ExpenseListOut:
    """List the caller's expenses, newest first, keyset-paginated."""
    stmt = select(Expense).where(Expense.user_id == user.id)
    if date_from is not None:  # inclusive on iso
        stmt = stmt.where(Expense.iso >= date_from)
    if date_to is not None:  # inclusive on iso
        stmt = stmt.where(Expense.iso <= date_to)
    if q is not None:
        pattern = f"%{q}%"
        stmt = stmt.where(
            or_(Expense.description.ilike(pattern), Expense.cat.ilike(pattern))
        )
    if cursor is not None:
        cursor_iso, cursor_id = _decode_cursor(cursor)
        stmt = stmt.where(tuple_(Expense.iso, Expense.id) < (cursor_iso, cursor_id))
    stmt = stmt.order_by(Expense.iso.desc(), Expense.id.desc()).limit(limit + 1)

    rows = (await db.scalars(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = _encode_cursor(rows[-1]) if has_more and rows else None
    return ExpenseListOut(
        items=[ExpenseOut.model_validate(row) for row in rows],
        next_cursor=next_cursor,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ExpenseOut)
async def create_expense(
    body: ExpenseIn, db: DbDep, user: CurrentUser, kv: KvDep
) -> ExpenseOut:
    """Record one expense (201 with the stored row)."""
    expense = Expense(
        user_id=user.id,
        cat=body.cat,
        grp=body.grp,
        amt=Decimal(body.amt),
        pay=body.pay,
        description=body.desc,
        iso=body.iso,
    )
    db.add(expense)
    await db.commit()
    await db.refresh(expense)  # pull server-side created_at
    await _invalidate_reports(kv, user.id, (expense.iso,))
    return ExpenseOut.model_validate(expense)


@router.post("/bulk", status_code=status.HTTP_201_CREATED, response_model=BulkExpensesOut)
async def create_expenses_bulk(
    body: BulkExpensesIn, db: DbDep, user: CurrentUser, kv: KvDep
) -> BulkExpensesOut:
    """Insert up to 50 expenses for the caller in a single flush."""
    expenses = [
        Expense(
            user_id=user.id,
            cat=item.cat,
            grp=item.grp,
            amt=Decimal(item.amt),
            pay=item.pay,
            description=item.desc,
            iso=item.iso,
        )
        for item in body.items
    ]
    db.add_all(expenses)
    await db.commit()
    for expense in expenses:  # pull server-side created_at
        await db.refresh(expense)
    await _invalidate_reports(kv, user.id, (expense.iso for expense in expenses))
    return BulkExpensesOut(
        items=[ExpenseOut.model_validate(expense) for expense in expenses]
    )


@router.patch("/{expense_id}", response_model=ExpenseOut)
async def update_expense(
    expense_id: uuid.UUID, body: ExpenseUpdate, db: DbDep, user: CurrentUser, kv: KvDep
) -> ExpenseOut:
    """Partially update the caller's expense (omitted fields stay as-is)."""
    expense = await _get_owned(db, user, expense_id)
    updates = body.model_dump(exclude_unset=True)
    old_iso = expense.iso
    if "amt" in updates:
        updates["amt"] = Decimal(str(updates["amt"]))
    for field, value in updates.items():
        setattr(expense, _UPDATE_FIELD_MAP.get(field, field), value)
    await db.commit()
    await db.refresh(expense)
    await _invalidate_reports(kv, user.id, {old_iso, expense.iso})
    return ExpenseOut.model_validate(expense)


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(
    expense_id: uuid.UUID, db: DbDep, user: CurrentUser, kv: KvDep
) -> None:
    """Delete the caller's expense (204; unknown/foreign id → 404)."""
    expense = await _get_owned(db, user, expense_id)
    await db.delete(expense)
    await db.commit()
    await _invalidate_reports(kv, user.id, (expense.iso,))
