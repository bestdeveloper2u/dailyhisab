"""Phase 3 budgets: monthly budget view + upsert.

GET returns the stored budget (defaults: ``total 20000.00``, ``cats {}``)
merged with that month's actual spending, computed in ONE grouped query
(``GROUP BY cat``) — no N+1. ``by_cat`` is the union of budgeted categories
and categories with spend in the month: budgeted-without-spend shows
``spent "0.00"``, spend-without-budget shows ``budget "0.00"`` (its
``usage_pct`` stays 0.0 to avoid a division by zero — callers compare
``budget`` vs ``spent`` directly for that case). ``usage_pct`` is
``spent / budget * 100`` rounded to 2 places.
"""

import calendar
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.budget import DEFAULT_BUDGET_TOTAL, Budget
from app.models.expense import Expense
from app.models.profile import Profile
from app.schemas.budget import BudgetCatUsage, BudgetIn, BudgetOut

router = APIRouter(prefix="/budgets", tags=["budgets"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

_ZERO = Decimal(0)
_TWO_PLACES = Decimal("0.01")

_BAD_YM = {
    "code": "invalid_ym",
    "message_bn": "সাল-মাস ফরম্যাট হবে YYYY-MM",
    "message_en": "Invalid month format, expected YYYY-MM",
}


def _money(value: Decimal) -> str:
    return str(value.quantize(_TWO_PLACES))


def _pct(spent: Decimal, budget: Decimal) -> float:
    if budget <= _ZERO:
        return 0.0
    return round(float(spent / budget * 100), 2)


def _parse_ym(ym: str | None) -> tuple[str, date, date]:
    """Normalize ``?ym=`` to (``YYYY-MM``, first day, last day); 422 on junk."""
    if ym is None:
        today = datetime.now(UTC).date()
        year, month = today.year, today.month
    else:
        try:
            parsed = date.fromisoformat(f"{ym}-01")
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=_BAD_YM
            ) from None
        year, month = parsed.year, parsed.month
    target = f"{year:04d}-{month:02d}"
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    return target, start, end


async def _spent_by_cat(
    db: AsyncSession, user_id: uuid.UUID | str, start: date, end: date
) -> dict[str, Decimal]:
    rows = await db.execute(
        select(Expense.cat, func.sum(Expense.amt))
        .where(Expense.user_id == user_id, Expense.iso >= start, Expense.iso <= end)
        .group_by(Expense.cat)
    )
    return {str(cat): Decimal(str(total)) for cat, total in rows.all()}


async def _budget_payload(
    db: AsyncSession, user: Profile, target: str, start: date, end: date
) -> BudgetOut:
    budget = await db.get(Budget, user.id)  # PK is user_id
    total = budget.total if budget is not None else DEFAULT_BUDGET_TOTAL
    cats: dict[str, str] = (
        {str(k): _money(Decimal(str(v))) for k, v in budget.cats.items()}
        if budget is not None and budget.cats
        else {}
    )
    spent_map = await _spent_by_cat(db, user.id, start, end)
    spent_total = sum(spent_map.values(), _ZERO)

    by_cat: dict[str, BudgetCatUsage] = {}
    for cat in sorted(set(cats) | set(spent_map)):
        budget_amt = Decimal(cats.get(cat, "0.00"))
        spent_amt = spent_map.get(cat, _ZERO)
        by_cat[cat] = BudgetCatUsage(
            budget=_money(budget_amt),
            spent=_money(spent_amt),
            usage_pct=_pct(spent_amt, budget_amt),
        )
    return BudgetOut(
        ym=target,
        total=_money(total),
        cats=cats,
        spent=_money(spent_total),
        usage_pct=_pct(spent_total, total),
        by_cat=by_cat,
    )


@router.get("", response_model=BudgetOut)
async def get_budgets(
    db: DbDep, user: CurrentUser, ym: Annotated[str | None, Query()] = None
) -> BudgetOut:
    """Budget vs spend for one month (``?ym=YYYY-MM``, default: current)."""
    target, start, end = _parse_ym(ym)
    return await _budget_payload(db, user, target, start, end)


@router.put("", response_model=BudgetOut)
async def put_budgets(body: BudgetIn, db: DbDep, user: CurrentUser) -> BudgetOut:
    """Upsert the caller's budget; returns the GET view for the current month."""
    budget = await db.get(Budget, user.id)
    if budget is None:
        budget = Budget(user_id=user.id)
        db.add(budget)
    updates = body.model_dump(exclude_unset=True)
    if updates.get("total") is not None:
        budget.total = Decimal(str(updates["total"]))
    if updates.get("cats") is not None:
        budget.cats = dict(updates["cats"])
    await db.commit()
    target, start, end = _parse_ym(None)
    return await _budget_payload(db, user, target, start, end)
