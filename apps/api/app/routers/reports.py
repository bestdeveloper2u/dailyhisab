"""Monthly/yearly expense reports, cached in KV (TTL 300s).

Cache keys (JSON payloads, dumped with ``sort_keys`` for stability):

* ``rep:monthly:<user_id>:<YYYY-MM>`` → :class:`MonthlyReportOut` shape
* ``rep:yearly:<user_id>:<year>``     → :class:`YearlyReportOut` shape

Every expense write (POST / bulk / PATCH / DELETE — see
:mod:`app.routers.expenses`) deletes both keys for the months/years its rows
touch, so a cache never outlives the data it summarizes.
"""

import calendar
import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user, get_kv_dep
from app.core.kv import KV
from app.db.session import get_db
from app.models.expense import Expense
from app.models.profile import Profile
from app.schemas.expense import (
    MonthlyReportOut,
    YearlyReportOut,
)

router = APIRouter(prefix="/reports", tags=["reports"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
KvDep = Annotated[KV, Depends(get_kv_dep)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

CACHE_TTL_SECONDS = 300
_ZERO = Decimal(0)
_TWO_PLACES = Decimal("0.01")

_BAD_YM = {
    "code": "invalid_ym",
    "message_bn": "সাল-মাস ফরম্যাট হবে YYYY-MM",
    "message_en": "Invalid month format, expected YYYY-MM",
}
_BAD_YEAR = {
    "code": "invalid_year",
    "message_bn": "সাল ফরম্যাট হবে YYYY",
    "message_en": "Invalid year format, expected YYYY",
}


def _money(value: Decimal) -> str:
    return str(value.quantize(_TWO_PLACES))


def _parse_ym(ym: str | None) -> tuple[str, date, date]:
    """Normalize ``?ym=`` to (``YYYY-MM``, first day, last day); 400 on junk."""
    if ym is None:
        today = datetime.now(UTC).date()
        year, month = today.year, today.month
    else:
        try:
            parsed = date.fromisoformat(f"{ym}-01")
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=_BAD_YM
            ) from None
        year, month = parsed.year, parsed.month
    target = f"{year:04d}-{month:02d}"
    start = date(year, month, 1)
    end = date(year, month, calendar.monthrange(year, month)[1])
    return target, start, end


def _parse_year(year: str | None) -> int:
    if year is None:
        return datetime.now(UTC).date().year
    try:
        parsed = int(year)
        if not 1 <= parsed <= 9999:
            raise ValueError("out of range")
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=_BAD_YEAR
        ) from None
    return parsed


async def _expense_rows(
    db: AsyncSession, user_id: str, start: date, end: date
) -> list[tuple[date, str, Decimal]]:
    rows = await db.execute(
        select(Expense.iso, Expense.grp, Expense.amt).where(
            Expense.user_id == uuid.UUID(user_id),
            Expense.iso >= start,
            Expense.iso <= end,
        )
    )
    return [(row[0], row[1], row[2]) for row in rows.all()]


async def _monthly_payload(
    db: AsyncSession, user_id: str, ym: str, start: date, end: date
) -> dict[str, object]:
    total, count = _ZERO, 0
    by_group: dict[str, Decimal] = {}
    by_day: dict[date, Decimal] = {}
    for iso, grp, amt in await _expense_rows(db, user_id, start, end):
        total += amt
        count += 1
        by_group[grp] = by_group.get(grp, _ZERO) + amt
        by_day[iso] = by_day.get(iso, _ZERO) + amt
    return {
        "ym": ym,
        "total": _money(total),
        "count": count,
        "by_group": {grp: _money(sum_) for grp, sum_ in sorted(by_group.items())},
        "by_day": [
            {"iso": day.isoformat(), "total": _money(sum_)}
            for day, sum_ in sorted(by_day.items())
        ],
    }


async def _yearly_payload(
    db: AsyncSession, user_id: str, year: int
) -> dict[str, object]:
    total, count = _ZERO, 0
    by_group: dict[str, Decimal] = {}
    by_month: dict[int, Decimal] = {}
    for iso, grp, amt in await _expense_rows(
        db, user_id, date(year, 1, 1), date(year, 12, 31)
    ):
        total += amt
        count += 1
        by_group[grp] = by_group.get(grp, _ZERO) + amt
        by_month[iso.month] = by_month.get(iso.month, _ZERO) + amt
    return {
        "year": year,
        "total": _money(total),
        "count": count,
        "by_group": {grp: _money(sum_) for grp, sum_ in sorted(by_group.items())},
        "by_month": [
            {"ym": f"{year:04d}-{month:02d}", "total": _money(by_month.get(month, _ZERO))}
            for month in range(1, 13)
        ],
    }


@router.get("/monthly", response_model=MonthlyReportOut)
async def monthly_report(
    db: DbDep, user: CurrentUser, kv: KvDep, ym: Annotated[str | None, Query()] = None
) -> MonthlyReportOut:
    """Aggregates for one month (``?ym=YYYY-MM``, default: current month)."""
    target, start, end = _parse_ym(ym)
    user_id = str(user.id)
    cache_key = f"rep:monthly:{user_id}:{target}"
    cached = await kv.get(cache_key)
    if cached is not None:
        return MonthlyReportOut.model_validate(json.loads(cached))
    payload = await _monthly_payload(db, user_id, target, start, end)
    await kv.setex(cache_key, CACHE_TTL_SECONDS, json.dumps(payload, sort_keys=True))
    return MonthlyReportOut.model_validate(payload)


@router.get("/yearly", response_model=YearlyReportOut)
async def yearly_report(
    db: DbDep, user: CurrentUser, kv: KvDep, year: Annotated[str | None, Query()] = None
) -> YearlyReportOut:
    """Aggregates for one year (``?year=YYYY``, default: current year)."""
    target_year = _parse_year(year)
    user_id = str(user.id)
    cache_key = f"rep:yearly:{user_id}:{target_year}"
    cached = await kv.get(cache_key)
    if cached is not None:
        return YearlyReportOut.model_validate(json.loads(cached))
    payload = await _yearly_payload(db, user_id, target_year)
    await kv.setex(cache_key, CACHE_TTL_SECONDS, json.dumps(payload, sort_keys=True))
    return YearlyReportOut.model_validate(payload)
