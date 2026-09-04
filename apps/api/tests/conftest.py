"""Shared pytest fixtures.

In-memory SQLite (StaticPool so all connections share the same DB),
create_all/drop_all from Base.metadata, get_db overridden to the test
sessionmaker, a fresh MemoryKV injected per test, and an httpx AsyncClient
speaking ASGI directly (no network).
"""

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool

import app.models
from app.core.deps import get_kv_dep
from app.core.kv import KV, MemoryKV
from app.db.base import Base
from app.db.session import get_db
from app.main import app

TEST_DATABASE_URL = "sqlite+aiosqlite://"


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest.fixture
async def sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def kv() -> MemoryKV:
    """Fresh in-memory KV per test (isolated sessions + rate-limit windows)."""
    return MemoryKV()


@pytest.fixture
async def client(
    sessionmaker: async_sessionmaker[AsyncSession],
    kv: MemoryKV,
) -> AsyncIterator[AsyncClient]:
    def override_get_kv() -> KV:
        return kv

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        async with sessionmaker() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_kv_dep] = override_get_kv
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
