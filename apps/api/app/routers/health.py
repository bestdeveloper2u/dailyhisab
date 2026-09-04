"""Health endpoint. Mounted twice: /api/v1/healthz and root /healthz."""

from fastapi import APIRouter

from app.core.config import get_settings
from app.schemas.health import Healthz

router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=Healthz)
async def healthz() -> Healthz:
    settings = get_settings()
    return Healthz(status="ok", version=settings.version, env=settings.env)
