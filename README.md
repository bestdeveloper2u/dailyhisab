# Daily Khoroch

দৈনিক খরচের হিসাব — voice-first expense tracker.

- Web: React 19 + TS + Vite + Tailwind v4
- API: Python 3.13 + FastAPI + SQLAlchemy 2 async (Supabase Postgres)
- Mobile: Expo (React Native)
- Cache: Valkey · Auth: custom JWT (Argon2id)

## Dev
```bash
pnpm install
cp apps/api/.env.example apps/api/.env  # adjust
cd apps/api && uv run alembic upgrade head && uv run uvicorn app.main:app --reload
cd apps/web && pnpm dev
```
