"""T16.1 recurring expenses (ADR-0014): rule CRUD + the idempotent
materialization run. Every endpoint is scoped to the authenticated user via
:meth:`app.core.deps.get_current_user`; user-scoped 404 everywhere.

A *rule* ("রুম ভাড়া, 12000.00, monthly, from 2026-09-01") never touches
reports directly — ``POST /recurring/run`` copies each due occurrence into a
real :class:`app.models.expense.Expense` row (column-for-column: ``cat``,
``grp``, ``amt``, ``pay``, ``desc``, ``iso``) and therefore invalidates the
report cache for every materialized month/year via
:func:`app.routers.expenses._invalidate_reports`.

Idempotency (ADR-0014 §3): each rule carries ``next_run`` — the earliest
occurrence date not yet materialized. The cursor only ever moves FORWARD
(create sets it to ``start_date``; the run advances it past today; PATCH
clamps it with ``max(current, start_date)``), so a repeated run finds nothing
due and inserts nothing. All of a run's inserts + cursor advances commit in
ONE transaction: a crash rolls back to the exact pre-run state.

Occurrence math is pure-stdlib calendar arithmetic with day clamping
(Jan 31 monthly → Feb 28; Feb 29 yearly → Feb 28). Catch-up is capped at
``_MAX_CATCH_UP`` occurrences per rule per run so a rule created "on
2020-01-01, monthly" cannot fan out unboundedly; the cursor still advances
correctly, so the next run picks up where this one stopped.
"""

import base64
import binascii
import calendar
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_kv_dep
from app.core.kv import KV
from app.db.session import get_db
from app.models.expense import Expense
from app.models.profile import Profile
from app.models.recurring import RecurringExpense
from app.routers.expenses import _invalidate_reports
from app.schemas.expense import ExpenseOut
from app.schemas.recurring import (
    RecurringIn,
    RecurringListOut,
    RecurringOut,
    RecurringRunOut,
    RecurringUpdate,
)

router = APIRouter(prefix="/recurring", tags=["recurring"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
KvDep = Annotated[KV, Depends(get_kv_dep)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

# Hard cap on catch-up occurrences per rule per run (ADR-0014 §4): bounds the
# fan-out of a back-dated rule while keeping daily/weekly catch-up useful
# (≈ 4 months of dailies). The cursor advances past everything computed, so
# the remainder materializes on the next run.
_MAX_CATCH_UP = 120

# RecurringUpdate uses the wire name; the ORM attribute is ``description``.
_UPDATE_FIELD_MAP = {"desc": "description"}

_NOT_FOUND = {
    "code": "not_found",
    "message_bn": "আবর্তনশীল খরচটি খুঁজে পাওয়া যায়নি",
    "message_en": "Recurring expense not found",
}
_INVALID_CURSOR = {
    "code": "invalid_cursor",
    "message_bn": "পেজিনেশন কার্সারটি অবৈধ",
    "message_en": "Invalid pagination cursor",
}


# --- occurrence math (pure functions; unit-tested directly) -----------------


def _add_months(d: date, months: int) -> date:
    """``d`` shifted ``months`` ahead with the day clamped to the month
    (Jan 31 + 1 month → Feb 28 in a non-leap year)."""
    total = d.month - 1 + months
    year = d.year + total // 12
    month = total % 12 + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def _next_occurrence(d: date, freq: str) -> date:
    """The occurrence immediately after ``d`` for the given frequency."""
    if freq == "daily":
        return d + timedelta(days=1)
    if freq == "weekly":
        return d + timedelta(weeks=1)
    if freq == "monthly":
        return _add_months(d, 1)
    return _add_months(d, 12)  # yearly: Feb 29 → Feb 28 off-years


def _due_occurrences(rule: RecurringExpense, today: date) -> tuple[list[date], date]:
    """Occurrences of ``rule`` in ``[rule.next_run, today]``, capped.

    Returns ``(occurrences, next_cursor)`` where ``next_cursor`` is the first
    occurrence date after them — the value ``next_run`` advances to, so
    re-running is a no-op (the idempotency mechanism, ADR-0014 §3).
    """
    out: list[date] = []
    cursor = rule.next_run
    while cursor <= today and len(out) < _MAX_CATCH_UP:
        out.append(cursor)
        cursor = _next_occurrence(cursor, rule.freq)
    return out, cursor


# --- cursor helpers (same opaque scheme as debts) ---------------------------


def _encode_cursor(rule: RecurringExpense) -> str:
    """Opaque keyset cursor: base64url of the anchor row's uuid.

    The ``(created_at, id)`` sort key is re-derived from that row inside the
    query (scalar subqueries), so the cursor itself only needs the id.
    """
    return base64.urlsafe_b64encode(str(rule.id).encode()).decode("ascii")


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


async def _get_owned(
    db: AsyncSession, user: Profile, recurring_id: uuid.UUID
) -> RecurringExpense:
    """Fetch the rule only if it belongs to ``user`` (404 otherwise)."""
    rule = await db.scalar(
        select(RecurringExpense).where(
            RecurringExpense.id == recurring_id,
            RecurringExpense.user_id == user.id,
        )
    )
    if rule is None:
        # Unknown id OR another user's id: identical 404, never leak existence.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return rule


# --- endpoints --------------------------------------------------------------


@router.get("", response_model=RecurringListOut)
async def list_recurring(
    db: DbDep,
    user: CurrentUser,
    active: Annotated[bool | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query()] = None,
) -> RecurringListOut:
    """List the caller's rules, newest first, keyset-paginated.

    ``?active=true`` keeps only running rules, ``false`` only paused ones;
    omit for both.
    """
    stmt = select(RecurringExpense).where(RecurringExpense.user_id == user.id)
    if active is not None:
        stmt = stmt.where(RecurringExpense.active.is_(active))
    if cursor is not None:
        cursor_id = _decode_cursor(cursor)
        # Keyset predicate for ORDER BY (created_at DESC, id DESC). The anchor
        # pair is read back from the cursor row itself (scalar subqueries) so
        # DB values compare to DB values — sidesteps the SQLite/PostgreSQL
        # datetime rendering mismatch (same trick as app.routers.debts).
        anchor_ts = (
            select(RecurringExpense.created_at)
            .where(RecurringExpense.id == cursor_id)
            .scalar_subquery()
        )
        stmt = stmt.where(
            or_(
                RecurringExpense.created_at < anchor_ts,
                and_(
                    RecurringExpense.created_at == anchor_ts,
                    RecurringExpense.id < cursor_id,
                ),
            )
        )
    stmt = stmt.order_by(
        RecurringExpense.created_at.desc(), RecurringExpense.id.desc()
    ).limit(limit + 1)

    rows = (await db.scalars(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = _encode_cursor(rows[-1]) if has_more and rows else None
    return RecurringListOut(
        items=[RecurringOut.model_validate(row) for row in rows],
        next_cursor=next_cursor,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=RecurringOut)
async def create_recurring(
    body: RecurringIn, db: DbDep, user: CurrentUser
) -> RecurringOut:
    """Create one rule (201 with the stored row).

    ``start_date`` is the FIRST occurrence and defaults to today; the
    materialization cursor starts there: ``next_run = start_date``.
    """
    start = body.start_date if body.start_date is not None else datetime.now(UTC).date()
    rule = RecurringExpense(
        user_id=user.id,
        cat=body.cat,
        grp=body.grp,
        amt=Decimal(body.amt),
        pay=body.pay,
        description=body.desc,
        freq=body.freq,
        start_date=start,
        next_run=start,
        active=True,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)  # pull server-side created_at/updated_at
    return RecurringOut.model_validate(rule)


@router.patch("/{recurring_id}", response_model=RecurringOut)
async def update_recurring(
    recurring_id: uuid.UUID, body: RecurringUpdate, db: DbDep, user: CurrentUser
) -> RecurringOut:
    """Partially update the caller's rule (omitted fields stay as-is).

    ``next_run`` is server-owned and forward-only (ADR-0014 §3): if the patch
    changes ``freq`` or ``start_date``, the cursor is clamped to
    ``max(current next_run, new start_date)`` — it can advance (a later
    start_date postpones materialization) but never rewind (which would
    re-materialize occurrences that already became expenses).
    """
    rule = await _get_owned(db, user, recurring_id)
    updates = body.model_dump(exclude_unset=True)
    if "amt" in updates:
        updates["amt"] = Decimal(str(updates["amt"]))
    retime = "freq" in updates or "start_date" in updates
    for field, value in updates.items():
        setattr(rule, _UPDATE_FIELD_MAP.get(field, field), value)
    if retime:
        rule.next_run = max(rule.next_run, rule.start_date)
    await db.commit()
    await db.refresh(rule)
    return RecurringOut.model_validate(rule)


@router.delete("/{recurring_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recurring(
    recurring_id: uuid.UUID, db: DbDep, user: CurrentUser
) -> None:
    """Delete the caller's rule (204; unknown/foreign id → 404).

    Deleting a rule never touches expenses it already materialized.
    """
    rule = await _get_owned(db, user, recurring_id)
    await db.delete(rule)
    await db.commit()


@router.post("/run", response_model=RecurringRunOut)
async def run_recurring(db: DbDep, user: CurrentUser, kv: KvDep) -> RecurringRunOut:
    """Materialize every due occurrence of the caller's active rules (ADR-0014).

    A rule is due while ``next_run <= today``. Each due occurrence becomes one
    ``expenses`` row with ``iso`` = the occurrence date (catch-up included, up
    to :data:`_MAX_CATCH_UP` per rule); then ``next_run`` moves past ``today``.
    Paused (``active=false``) and future-dated rules are skipped. Re-running
    the same day is a no-op: ``created: 0`` — the idempotency contract.
    """
    today = datetime.now(UTC).date()
    rules = (
        await db.scalars(
            select(RecurringExpense)
            .where(
                RecurringExpense.user_id == user.id,
                RecurringExpense.active.is_(True),
                RecurringExpense.next_run <= today,
            )
            .order_by(RecurringExpense.next_run, RecurringExpense.id)
        )
    ).all()

    expenses: list[Expense] = []
    dates: list[date] = []
    for rule in rules:
        occurrences, next_cursor = _due_occurrences(rule, today)
        for occ in occurrences:
            # Column-for-column copy from the rule (ADR-0014 §4); the expense
            # gets its own fresh uuid PK and server-side created_at.
            expenses.append(
                Expense(
                    user_id=user.id,
                    cat=rule.cat,
                    grp=rule.grp,
                    amt=rule.amt,
                    pay=rule.pay,
                    description=rule.description,
                    iso=occ,
                )
            )
            dates.append(occ)
        rule.next_run = next_cursor

    if expenses:
        db.add_all(expenses)
    # One transaction: every insert AND every cursor advance lands together,
    # so a crash rolls back to the exact pre-run state (never a half-run).
    await db.commit()
    for expense in expenses:  # pull server-side created_at
        await db.refresh(expense)
    # Materialized expenses move monthly/yearly report totals — bust the same
    # cache keys the manual expense writes do.
    await _invalidate_reports(kv, user.id, dates)
    return RecurringRunOut(
        ran_on=today,
        created=len(expenses),
        rules=len(rules),
        expenses=[ExpenseOut.model_validate(expense) for expense in expenses],
    )
