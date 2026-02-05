# Dashmon (dashmon.online) Agent Guide

## Goals
- Keep UI style consistent with current Tailwind/static HTML approach (no React migration).
- Never use the string "mondash" anywhere.
- Use term "Project" in UI (not Store).
- Multi-tenant: every API query must scope by req.user.id.

## Local dev commands
- Start stack: `docker compose up -d --build`
- Logs: `docker compose logs -f --tail=200 app worker`
- DB shell: `docker exec -it dashmon-postgres-1 psql -U dashmon -d dashmon`

## File layout
- Frontend: `public/app/`
- Backend: `server/` (Express)
- Worker: `worker/`

## Definition of done for changes
- No console errors in browser
- Buttons: Add Project / Add Device / Refresh / Logout work
- Project details page loads and shows device history chart
- API returns JSON errors (no HTML redirects) for /api routes
