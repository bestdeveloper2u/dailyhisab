"""Portable column types.

The API must run on PostgreSQL (Supabase, production) and SQLite (unit tests
+ local fallback). These TypeDecorators keep the Python-level semantics
identical across both dialects. See docs/adr/0005-database-portability.md.
"""

import uuid
from typing import Any

from sqlalchemy import CHAR, JSON, Dialect, TypeDecorator
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PGUUID


class GUID(TypeDecorator[uuid.UUID]):
    """Portable UUID primary-key type.

    * ``postgresql`` -> native ``UUID`` (with ``as_uuid=True``).
    * everything else (sqlite, ...) -> ``CHAR(36)`` storing canonical strings.

    ``process_result_value`` always returns ``uuid.UUID`` so attribute access
    is the same on every backend.
    """

    impl = CHAR
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value: uuid.UUID | str | None, dialect: Dialect) -> Any:
        if value is None:
            return None
        if isinstance(value, uuid.UUID):
            return value if dialect.name == "postgresql" else str(value)
        parsed = uuid.UUID(str(value))
        return parsed if dialect.name == "postgresql" else str(parsed)

    def process_result_value(self, value: Any, dialect: Dialect) -> uuid.UUID | None:
        if value is None:
            return None
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


class JSONVariant(TypeDecorator[dict[str, Any]]):
    """Portable JSON mapping: ``JSONB`` on postgresql, ``JSON`` elsewhere."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())
