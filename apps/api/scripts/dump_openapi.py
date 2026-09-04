"""Dump the FastAPI OpenAPI schema to openapi.json (committed, feeds
packages/api-client generation). Run: uv run python scripts/dump_openapi.py
"""

import json
from pathlib import Path

from app.main import app

OUT_PATH = Path(__file__).resolve().parent.parent / "openapi.json"


def main() -> None:
    spec = json.dumps(app.openapi(), indent=2, sort_keys=True)
    OUT_PATH.write_text(spec, encoding="utf-8")
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
