"""initial schema: profiles, expenses, debts, budgets

Revision ID: 0001
Revises:
Create Date: 2026-09-04

Handwritten so it is deterministic and portable: `sa.Uuid()` renders native
UUID on PostgreSQL and CHAR(36) on SQLite; JSON gets a JSONB variant on
PostgreSQL. Constraint names follow the naming convention in app/db/base.py.
Server defaults use CURRENT_TIMESTAMP / CURRENT_DATE, which both SQLite and
PostgreSQL support (see docs/adr/0005-database-portability.md).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "name", sa.Text(), server_default=sa.text("'ডেমো ব্যবহারকারী'"), nullable=False
        ),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("lang", sa.Text(), server_default=sa.text("'bn'"), nullable=False),
        sa.Column("theme", sa.Text(), server_default=sa.text("'light'"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.CheckConstraint("lang IN ('bn', 'en')", name=op.f("ck_profiles_lang_valid")),
        sa.CheckConstraint("theme IN ('light', 'dark')", name=op.f("ck_profiles_theme_valid")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_profiles")),
    )

    op.create_table(
        "expenses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("cat", sa.Text(), nullable=False),
        sa.Column("grp", sa.Text(), nullable=False),
        sa.Column("amt", sa.Numeric(12, 2), nullable=False),
        sa.Column("pay", sa.Text(), server_default=sa.text("'cash'"), nullable=False),
        sa.Column("desc", sa.Text(), nullable=True),
        sa.Column("iso", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.CheckConstraint("amt >= 0", name=op.f("ck_expenses_amt_nonneg")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_expenses_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_expenses")),
    )
    op.create_index(
        "expenses_user_iso", "expenses", ["user_id", sa.text("iso DESC")], unique=False
    )

    op.create_table(
        "debts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("party", sa.Text(), nullable=False),
        sa.Column("dir", sa.Text(), nullable=False),
        sa.Column("amt", sa.Numeric(12, 2), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("iso", sa.Date(), server_default=sa.text("CURRENT_DATE"), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.CheckConstraint("amt > 0", name=op.f("ck_debts_amt_positive")),
        sa.CheckConstraint("dir IN ('lend', 'borrow')", name=op.f("ck_debts_dir_valid")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_debts_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_debts")),
    )
    op.create_index("debts_user", "debts", ["user_id", "party"], unique=False)

    op.create_table(
        "budgets",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "total", sa.Numeric(12, 2), server_default=sa.text("'20000'"), nullable=False
        ),
        sa.Column(
            "cats",
            sa.JSON().with_variant(postgresql.JSONB(), "postgresql"),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_budgets_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_budgets")),
    )


def downgrade() -> None:
    op.drop_table("budgets")
    op.drop_index("debts_user", table_name="debts")
    op.drop_table("debts")
    op.drop_index("expenses_user_iso", table_name="expenses")
    op.drop_table("expenses")
    op.drop_table("profiles")
