"""recurring_expenses (T16.1, ADR-0014)

Revision ID: 0003
Revises: 0002
Create Date: 2026-09-05

One table for recurring-expense rules. Payload columns mirror ``expenses``
(``cat``/``grp``/``amt``/``pay``/``desc``) so the materialization run copies a
rule into an expense column-for-column. ``next_run`` is the idempotency
cursor: the earliest occurrence not yet materialized (forward-only — see
ADR-0014 §3). Written by hand in the 0001 style: ``sa.Uuid()`` renders native
UUID on PostgreSQL and CHAR(36) on SQLite; constraint names follow the
naming convention in app/db/base.py; server defaults (CURRENT_TIMESTAMP,
``true``) are portable across SQLite and PostgreSQL (ADR-0005).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "recurring_expenses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("cat", sa.Text(), nullable=False),
        sa.Column("grp", sa.Text(), nullable=False),
        sa.Column("amt", sa.Numeric(12, 2), nullable=False),
        sa.Column("pay", sa.Text(), server_default=sa.text("'cash'"), nullable=False),
        sa.Column("desc", sa.Text(), nullable=True),
        sa.Column("freq", sa.Text(), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("next_run", sa.Date(), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.CheckConstraint("amt >= 0", name=op.f("ck_recurring_expenses_amt_nonneg")),
        sa.CheckConstraint(
            "freq IN ('daily', 'weekly', 'monthly', 'yearly')",
            name=op.f("ck_recurring_expenses_freq_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_recurring_expenses_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recurring_expenses")),
    )
    op.create_index(
        "recurring_user_next",
        "recurring_expenses",
        ["user_id", "next_run"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("recurring_user_next", table_name="recurring_expenses")
    op.drop_table("recurring_expenses")
