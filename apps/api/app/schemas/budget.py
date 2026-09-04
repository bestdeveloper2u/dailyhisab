"""Budget schemas (wire contract per ADR-0004).

Rules implemented here (do not drift):

* money is a decimal STRING with exactly 2 places ("20000.00") — never a JSON
  number; budgets allow >= 0 (mirrors the expenses CHECK domain, ADR-0004 §1);
* JSON keys mirror DB columns: ``total``, ``cats`` — ``cats`` maps a category
  name to its per-month budget string;
* ``usage_pct`` is the one *derived* float (a percentage, not money) — kept
  as a number for direct UI binding, rounded to 2 places.
"""

from typing import Annotated

from pydantic import BaseModel, Field, field_validator

from app.schemas.expense import AmtStr

# Per-category budget values: same 2dp non-negative string rule as amounts.
CatAmtStr = Annotated[str, Field(pattern=r"^\d{1,10}\.\d{2}$", examples=["8000.00"])]


class BudgetIn(BaseModel):
    """PUT /budgets body — both fields optional (partial upsert)."""

    total: AmtStr | None = None
    cats: dict[Annotated[str, Field(min_length=1, max_length=80)], CatAmtStr] | None = None

    @field_validator("cats")
    @classmethod
    def _cap_category_count(cls, cats: dict[str, str] | None) -> dict[str, str] | None:
        if cats is not None and len(cats) > 100:
            raise ValueError("too many categories (max 100)")
        return cats


class BudgetCatUsage(BaseModel):
    """Per-category budget vs actual spend for one month."""

    budget: str
    spent: str
    usage_pct: float


class BudgetOut(BaseModel):
    """GET /budgets body: stored budget merged with that month's spending."""

    ym: str
    total: str
    cats: dict[str, str]
    spent: str
    usage_pct: float
    by_cat: dict[str, BudgetCatUsage]
