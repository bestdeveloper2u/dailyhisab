"""Health endpoint contract tests (Phase 1)."""

from httpx import AsyncClient


async def test_root_healthz(client: AsyncClient) -> None:
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "version": "0.3.0", "env": "local"}


async def test_api_v1_healthz(client: AsyncClient) -> None:
    resp = await client.get("/api/v1/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "version": "0.3.0", "env": "local"}
