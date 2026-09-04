# khoroch-api

FastAPI backend for **Daily Khoroch** — Python 3.13, SQLAlchemy 2 (async),
Alembic, managed with [uv](https://docs.astral.sh/uv/).

## Layout

```
app/
├── core/config.py     pydantic-settings (env prefix KHOROCH_)
├── db/                base, portable types (GUID, JSONVariant), async session
├── models/            profiles, expenses, debts, budgets
├── routers/           /healthz (mounted at / and /api/v1)
├── schemas/           pydantic response models
├── docs/adr/          see app/docs/adr (repo-level: ../docs/adr)
├── main.py            FastAPI app factory (docs at /api/docs)
alembic/               async env + handwritten migrations
scripts/dump_openapi.py
tests/
```

## Run

```bash
uv sync                                   # create .venv + install deps (incl. dev)
cp .env.example .env                      # optional; defaults to local sqlite

# dev server with sqlite (default) — http://127.0.0.1:8000/api/docs
uv run uvicorn app.main:app --reload

# dev server against local postgres
export KHOROCH_DATABASE_URL=postgresql+asyncpg://khoroch:khoroch@localhost:54329/khoroch
uv run uvicorn app.main:app --reload
```

## Migrations

```bash
# sqlite (default)
uv run alembic upgrade head
uv run alembic downgrade base

# postgres
KHOROCH_DATABASE_URL=postgresql+asyncpg://khoroch:khoroch@localhost:54329/khoroch \
  uv run alembic upgrade head
```

## Gates (Definition of Done)

```bash
uv run ruff check .
uv run mypy app
uv run pytest -q
uv run python scripts/dump_openapi.py    # regenerate openapi.json
```

Phase 1 has no auth (custom JWT lands in a later cycle). DB portability
decisions: `app/docs/adr/0005-database-portability.md`.
