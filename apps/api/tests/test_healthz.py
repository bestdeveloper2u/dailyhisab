"""Health endpoint contract tests (Phase 1)."""

from httpx import AsyncClient

from app.core.config import get_settings


async def test_root_healthz(client: AsyncClient) -> None:
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "version": get_settings().version,
        "env": "local",
    }


async def test_api_v1_healthz(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/healthz")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "version": get_settings().version,
        "env": "local",
    }
