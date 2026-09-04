"""FastAPI application entrypoint.

Phase 1: health + auth (register/login/refresh/logout/me, rotating refresh
tokens per ADR-0002). Phase 2: expenses CRUD + bulk (keyset cursor
pagination), rule-based Bengali voice parsing, and cached monthly/yearly
reports. Run locally: uv run uvicorn app.main:app --reload
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.kv import close_kv
from app.db.session import dispose_engine
from app.routers import auth, expenses, health, reports, voice

logger = logging.getLogger("khoroch.api")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logger.info(
        "Starting %s v%s (env=%s)", settings.app_name, settings.version, settings.env
    )
    yield
    await close_kv()
    await dispose_engine()
    logger.info("Shutting down %s", settings.app_name)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Daily Khoroch API",
        version=settings.version,
        docs_url="/api/docs",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Versioned surface ...
    app.include_router(health.router, prefix="/api/v1")
    app.include_router(auth.router, prefix="/api/v1")
    app.include_router(expenses.router, prefix="/api/v1")
    app.include_router(voice.router, prefix="/api/v1")
    app.include_router(reports.router, prefix="/api/v1")
    # ... plus a root-level /healthz for load balancers (same handler).
    app.include_router(health.router)
    return app


app = create_app()
