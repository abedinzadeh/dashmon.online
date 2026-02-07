# Dashmon Smoke Test

This repo includes a small smoke test that can be run after build/deploy to confirm the app is healthy.

## What it checks

- `GET /api/health` returns `{ ok: true }` (and DB is reachable)
- Local login works (session cookie)
- `GET /api/me` returns an expected shape
- `GET /api/projects` returns an array (and basic shape when non-empty)

## Run on the server

From the repo root:

```bash
export SMOKE_BASE_URL="http://127.0.0.1:3000"
export SMOKE_IDENTIFIER="smoke@yourdomain.com"   # email OR username
export SMOKE_PASSWORD="StrongPasswordHere"

npm --prefix server run smoke
```

### Optional: auto-signup (useful for CI)

```bash
export SMOKE_SIGNUP=1
export SMOKE_EMAIL="smoke@example.com"         # optional
export SMOKE_USERNAME="smokeuser"              # optional

npm --prefix server run smoke
```

## Exit codes

- `0` = all checks passed
- non-zero = at least one check failed (prints a clear error)
