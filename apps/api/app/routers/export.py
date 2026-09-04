"""Phase 3 CSV export: GET /export/expenses.csv?from=&to=.

Streamed as ``text/csv; charset=utf-8`` with a UTF-8 BOM first (Excel needs
it for the Bengali text) and RFC 4180 quoting (the stdlib ``csv`` module's
excel dialect with ``lineterminator="\\r\\n"``: fields containing a comma,
a double quote, or CR/LF are wrapped in double quotes with embedded quotes
doubled). Empty range → header-only file.

Header row uses the prototype i18n labels (www/index.html bn dict:
``date``/``item``/``category``/``amount``/``payment`` + the group label), so
the file matches what Bengali users see in the UI:

    তারিখ,বিবরণ,গ্রুপ,খাত,পরিমাণ (৳),পেমেন্ট

Column order mirrors the wire keys: iso, desc, grp, cat, amt, pay. Rows are
ordered ``iso ASC, id ASC`` and fetched in keyset batches (500 rows per
query) so memory stays bounded regardless of history size. Current user's
rows only.
"""

import csv
import io
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db
from app.models.expense import Expense
from app.models.profile import Profile

router = APIRouter(prefix="/export", tags=["export"])

DbDep = Annotated[AsyncSession, Depends(get_db)]
CurrentUser = Annotated[Profile, Depends(get_current_user)]

BOM = "\ufeff"
CSV_HEADER = ["তারিখ", "বিবরণ", "গ্রুপ", "খাত", "পরিমাণ (৳)", "পেমেন্ট"]
BATCH_SIZE = 500
_TWO_PLACES = Decimal("0.01")

_BAD_RANGE = {
    "code": "invalid_date_range",
    "message_bn": "'from' তারিখ 'to' তারিখের আগে হতে হবে",
    "message_en": "'from' must be on or before 'to'",
}


def _money(value: Decimal | float | str) -> str:
    return str(Decimal(str(value)).quantize(_TWO_PLACES))


async def _csv_bytes(
    db: AsyncSession, user_id: uuid.UUID | str, date_from: date | None, date_to: date | None
) -> AsyncIterator[bytes]:
    """Yield the CSV body in batches (BOM + header, then keyset pages)."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(CSV_HEADER)
    yield (BOM + buf.getvalue()).encode("utf-8")

    last: tuple[date, uuid.UUID] | None = None
    while True:
        stmt = select(Expense.iso, Expense.description, Expense.grp, Expense.cat, Expense.amt, Expense.pay, Expense.id).where(
            Expense.user_id == user_id
        )
        if date_from is not None:
            stmt = stmt.where(Expense.iso >= date_from)
        if date_to is not None:
            stmt = stmt.where(Expense.iso <= date_to)
        if last is not None:
            stmt = stmt.where(tuple_(Expense.iso, Expense.id) > last)
        stmt = stmt.order_by(Expense.iso, Expense.id).limit(BATCH_SIZE)

        rows = (await db.execute(stmt)).all()
        if not rows:
            break
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\r\n")
        for iso, desc, grp, cat, amt, pay, row_id in rows:
            writer.writerow([iso.isoformat(), desc or "", grp, cat, _money(amt), pay])
            last = (iso, row_id)
        yield buf.getvalue().encode("utf-8")


@router.get("/expenses.csv")
async def export_expenses_csv(
    db: DbDep,
    user: CurrentUser,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
) -> StreamingResponse:
    """Stream the caller's expenses as a Bengali-friendly CSV attachment."""
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=_BAD_RANGE
        )
    today = datetime.now(UTC).date()
    filename = f"expenses-{today:%Y%m%d}.csv"
    return StreamingResponse(
        _csv_bytes(db, user.id, date_from, date_to),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
