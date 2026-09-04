"""profiles: add password_hash for Phase 1 API-layer auth

Revision ID: 0002
Revises: 0001
Create Date: 2026-09-04

``profiles`` is the user table; Phase 1 keeps identity at the API layer, so
it needs an Argon2id hash column. Nullable: pre-existing profiles (e.g. the
demo row) have no password until seeded/logged-in.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "profiles", sa.Column("password_hash", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("profiles", "password_hash")
