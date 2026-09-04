"""Phase 3 debts: list (keyset cursor pagination), create, patch, pay
close-out (PARTIAL/FULL), delete. Every endpoint is scoped to the
authenticated user via :meth:`app.core.deps.get_current_user`.

Cursor pagination (same opaque base64url scheme as
:mod:`app.routers.expenses`): the cursor carries the uuid of the last row of
the previous page, and the query re-derives that row's ``(iso, created_at,
id)`` anchor via scalar subqueries to filter "rows strictly after it in
``ORDER BY iso DESC, created_at DESC, id DESC``". Comparing DB values to DB
values (instead of literal timestamps) keeps the sort-key comparison exact
on both SQLite and PostgreSQL despite their datetime storage differences;
the uuid is the final deterministic tiebreak, so the ordering is total and
pagination is stable.
"""

import base64
import binascii
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.debt import Debt
from app.models.profile import Profile
from app.schemas.debt import (
    DebtIn,
    DebtListOut,
    DebtOut,
    DebtPayIn,
    DebtPayOut,
    DebtUpdate,
)

router = APIRouter(prefix="/debts", tags=["debts"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

_NOT_FOUND = {
    "code": "not_found",
    "message_bn": "ধারটি খুঁজে পাওয়া যায়নি",
    "message_en": "Debt not found",
}
_ALREADY_SETTLED = {
    "code": "debt_already_settled",
    "message_bn": "এই ধারটি আগেই পরিশোধ করা হয়েছে",
    "message_en": "This debt is already settled",
}
_INVALID_CURSOR = {
    "code": "invalid_cursor",
    "message_bn": "পেজিনেশন কার্সারটি অবৈধ",
    "message_en": "Invalid pagination cursor",
}


# --- cursor helpers ---------------------------------------------------------


def _encode_cursor(debt: Debt) -> str:
    """Opaque keyset cursor: base64url of the anchor row's uuid.

    The full ``(iso, created_at, id)`` sort key is re-derived from that row
    inside the query, so the cursor itself only needs the id.
    """
    return base64.urlsafe_b64encode(str(debt.id).encode()).decode("ascii")


def _decode_cursor(cursor: str) -> uuid.UUID:
    try:
        return uuid.UUID(
            base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        )
    except (ValueError, binascii.Error, UnicodeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_INVALID_CURSOR
        ) from None


# --- shared query pieces ----------------------------------------------------


async def _get_owned(db: AsyncSession, user: Profile, debt_id: uuid.UUID) -> Debt:
    """Fetch the debt only if it belongs to ``user`` (404 otherwise)."""
    debt = await db.scalar(
        select(Debt).where(Debt.id == debt_id, Debt.user_id == user.id)
    )
    if debt is None:
        # Unknown id OR another user's id: identical 404, never leak existence.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return debt


# --- endpoints --------------------------------------------------------------


@router.get("", response_model=DebtListOut)
async def list_debts(
    db: DbDep,
    user: CurrentUser,
    debt_status: Annotated[
        Literal["open", "settled", "all"], Query(alias="status")
    ] = "open",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> DebtListOut:
    """List the caller's debts, newest first, keyset-paginated.

    ``?status=open`` (default) keeps rows with ``settled_at IS NULL``;
    ``settled`` the complement; ``all`` both.
    """
    stmt = select(Debt).where(Debt.user_id == user.id)
    if debt_status == "open":
        stmt = stmt.where(Debt.settled_at.is_(None))
    elif debt_status == "settled":
        stmt = stmt.where(Debt.settled_at.is_not(None))
    if cursor is not None:
        cursor_id = _decode_cursor(cursor)
        # Keyset predicate for ORDER BY (iso DESC, created_at DESC, id DESC).
        # The anchor triple is read back from the cursor row itself (scalar
        # subqueries): comparing DB values to DB values sidesteps the dialect
        # datetime-format mismatch (SQLite CURRENT_TIMESTAMP stores no
        # fractional seconds while bound datetime params render ".000000",
        # which breaks literal equality and duplicates rows at page edges).
        anchor_iso = select(Debt.iso).where(Debt.id == cursor_id).scalar_subquery()
        anchor_ts = (
            select(Debt.created_at).where(Debt.id == cursor_id).scalar_subquery()
        )
        stmt = stmt.where(
            or_(
                Debt.iso < anchor_iso,
                and_(Debt.iso == anchor_iso, Debt.created_at < anchor_ts),
                and_(
                    Debt.iso == anchor_iso,
                    Debt.created_at == anchor_ts,
                    Debt.id < cursor_id,
                ),
            )
        )
    stmt = stmt.order_by(Debt.iso.desc(), Debt.created_at.desc(), Debt.id.desc()).limit(
        limit + 1
    )

    rows = (await db.scalars(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = _encode_cursor(rows[-1]) if has_more and rows else None
    return DebtListOut(
        items=[DebtOut.model_validate(row) for row in rows],
        next_cursor=next_cursor,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=DebtOut)
async def create_debt(body: DebtIn, db: DbDep, user: CurrentUser) -> DebtOut:
    """Record one debt (201 with the stored row; ``iso`` defaults to today)."""
    debt = Debt(
        user_id=user.id,
        party=body.party,
        dir=body.dir,
        amt=Decimal(body.amt),
        note=body.note,
        iso=body.iso if body.iso is not None else datetime.now(UTC).date(),
    )
    db.add(debt)
    await db.commit()
    await db.refresh(debt)  # pull server-side created_at
    return DebtOut.model_validate(debt)


@router.patch("/{debt_id}", response_model=DebtOut)
async def update_debt(
    debt_id: uuid.UUID, body: DebtUpdate, db: DbDep, user: CurrentUser
) -> DebtOut:
    """Partially update the caller's debt (omitted fields stay as-is)."""
    debt = await _get_owned(db, user, debt_id)
    updates = body.model_dump(exclude_unset=True)
    if "amt" in updates:
        updates["amt"] = Decimal(str(updates["amt"]))
    for field, value in updates.items():
        setattr(debt, field, value)
    await db.commit()
    await db.refresh(debt)
    return DebtOut.model_validate(debt)


@router.post("/{debt_id}/pay", response_model=DebtPayOut)
async def pay_debt(
    debt_id: uuid.UUID, body: DebtPayIn, db: DbDep, user: CurrentUser
) -> DebtPayOut:
    """Close out a debt with a payment.

    ``amt >= debt.amt`` → FULL: the debt settles (``settled_at`` = now UTC,
    the stored amount is left untouched — overpay is not recorded).
    ``0 < amt < debt.amt`` → PARTIAL: the remaining amount shrinks.
    Paying an already-settled debt → 409 ``debt_already_settled``.
    """
    debt = await _get_owned(db, user, debt_id)
    if debt.settled_at is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=_ALREADY_SETTLED
        )
    payment = Decimal(body.amt)
    outcome: Literal["FULL", "PARTIAL"]
    if payment >= debt.amt:
        debt.settled_at = datetime.now(UTC)
        outcome = "FULL"
    else:
        debt.amt = debt.amt - payment
        outcome = "PARTIAL"
    await db.commit()
    await db.refresh(debt)
    return DebtPayOut(status=outcome, debt=DebtOut.model_validate(debt))


@router.delete("/{debt_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_debt(debt_id: uuid.UUID, db: DbDep, user: CurrentUser) -> None:
    """Delete the caller's debt (204; unknown/foreign id → 404)."""
    debt = await _get_owned(db, user, debt_id)
    await db.delete(debt)
    await db.commit()
