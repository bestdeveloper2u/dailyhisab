"""Run Alembic against the PRODUCTION database (ops helper).

T16.5 cycle-16: ``alembic upgrade head`` must target Supabase, but
``get_settings().database_url`` normally points at the transaction pooler
(asyncpg, pgbouncer-safe) while DDL wants the session-mode URL
(``KHOROCH_DIRECT_URL`` in apps/api/.env). This helper swaps the URL
in-process so the secret never reaches argv, logs, or the repo.

Usage (from apps/api, with the project venv):
    uv run python scripts/alembic_prod.py current
    uv run python scripts/alembic_prod.py upgrade head
    uv run python scripts/alembic_prod.py heads
"""

import os
import sys
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env_file(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines, '#' comments, strip quotes.

    ``setdefault`` semantics: real environment variables win over the file,
    matching pydantic-settings precedence.
    """
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def main() -> None:
    if not ENV_FILE.exists():
        raise SystemExit(f".env not found at {ENV_FILE} — aborting")
    load_env_file(ENV_FILE)

    direct = os.environ.get("KHOROCH_DIRECT_URL", "").strip()
    if not direct:
        raise SystemExit("KHOROCH_DIRECT_URL missing from .env — aborting")
    # Alembic DDL runs on the session-mode URL (see module docstring).
    os.environ["KHOROCH_DATABASE_URL"] = direct

    from alembic.config import main as alembic_main

    argv = sys.argv[1:] or ["current"]
    alembic_main(argv=argv, prog_name="alembic-prod")


if __name__ == "__main__":
    main()
