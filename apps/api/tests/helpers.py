"""Shared test helpers (imported by the test modules via pytest's rootdir
path insertion — the tests/ dir has no __init__.py)."""

from httpx import AsyncClient


async def register_user(
    client: AsyncClient,
    email: str = "user@test.dev",
    password: str = "password123",
) -> tuple[dict[str, str], str]:
    """Register a fresh user; return ``(Authorization headers, user_id)``."""
    r = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": password}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    return {"Authorization": f"Bearer {body['accessToken']}"}, body["user"]["id"]


def expense_body(**overrides: object) -> dict[str, object]:
    """Minimal valid POST /expenses payload with overrides applied."""
    body: dict[str, object] = {
        "cat": "চা",
        "grp": "food",
        "amt": "50.00",
        "iso": "2026-09-01",
    }
    body.update(overrides)
    return body
