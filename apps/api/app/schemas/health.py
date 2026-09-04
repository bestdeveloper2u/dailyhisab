"""Health check response schema."""

from pydantic import BaseModel


class Healthz(BaseModel):
    status: str
    version: str
    env: str
