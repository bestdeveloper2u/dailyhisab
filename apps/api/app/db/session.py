"""Async engine / session factory and the FastAPI ``get_db`` dependency.

The engine is created lazily from settings so importing :mod:`app.main` never
opens a database connection (keeps OpenAPI dumping and tests hermetic).
"""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine_and_sessionmaker() -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """Create (once) and return the process-wide async engine + sessionmaker."""
    global _engine, _sessionmaker
    if _engine is None or _sessionmaker is None:
        settings = get_settings()
        connect_args: dict = {}
        if "pooler.supabase.com" in settings.database_url or "pgbouncer=true" in settings.database_url:
            # Transaction-mode poolers (pgbouncer/Supabase pooler) do not support
            # asyncpg prepared statements — disable the driver-level cache.
            connect_args["statement_cache_size"] = 0
        _engine = create_async_engine(
            settings.database_url,
            pool_pre_ping=True,
            connect_args=connect_args,
        )
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine, _sessionmaker


async def dispose_engine() -> None:
    """Dispose the engine if it was created (used on graceful shutdown)."""
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding an ``AsyncSession``.

    Rollback on error, always close.
    """
    _, sessionmaker = get_engine_and_sessionmaker()
    session = sessionmaker()
    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()
