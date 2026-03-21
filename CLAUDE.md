# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TekNaBox is an MSP (Managed Service Provider) RMM platform with two components:
- **platform/** — Docker-based server: FastAPI backend + React frontend
- **agent/** — Python agent installed on Linux client devices

## Common Commands

### Platform (platform/)

```bash
# Start the full stack
cd platform
docker compose up -d

# Rebuild and restart a specific service after code changes
docker compose build api && docker compose up -d api
docker compose build ui && docker compose up -d ui

# Tail logs
docker compose logs -f api
docker compose logs -f ui
```

### Frontend development (platform/ui)

```bash
cd platform/ui
npm install
npm run dev      # Dev server on :5173, proxies /v1 to localhost:8005
npm run build    # Production build → dist/
```

### Backend interactive docs

Set `ENVIRONMENT=development` in platform/server/.env, restart the api container, then visit `http://localhost:8000/docs`.

### Run the integration test suite

```bash
cd platform/server
python test_flow.py [--base-url http://localhost:8000]
# Env overrides: SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD
```

The test exercises 19 steps: health check, auth, device enrollment, task dispatch, update rollout, revocation, and audit logging.

### Agent (agent/)

```bash
# Deploy to a device
scp -r agent/ user@device:/home/user/
ssh user@device
sudo bash /home/user/agent/install.sh --server https://yourserver.com --secret <enrollment_secret>
```

## Architecture

### Multi-tenant hierarchy

`MSPOrganization → CustomerOrganization → Site → Device`

### Platform services (docker-compose.yml)

| Service | Port | Role |
|---------|------|------|
| db | 5432 (internal) | PostgreSQL 16 |
| redis | 6379 (internal) | Redis 7 — Celery broker + pub/sub |
| api | 8005 (host) | FastAPI + 4 Uvicorn workers |
| worker | — | Celery background task processor |
| ui | 3005 (host) | React via nginx |

Nginx Proxy Manager handles TLS termination externally. **WebSocket support must be enabled in NPM** for the device channel to work. Production server: `https://tekn-api.synhow.com`

### API (platform/server/app/)

- **main.py** — FastAPI app, lifespan, auto-bootstrap of super admin on first run
- **api/v1/** — Routers: `enrollment`, `device_channel` (WebSocket), `management`, `admin`, `monitoring`, `ad_recon`, `security`, `terminal`, `bandwidth`
- **models/models.py** — All SQLAlchemy ORM models (~27KB)
- **core/** — `auth.py` (JWT deps), `config.py` (Pydantic settings), `database.py` (async engine), `security.py` (hashing/tokens)
- **services/connection_manager.py** — WebSocket + Redis pub/sub relay (any API instance can message any connected device)
- **services/audit.py** — Write-once audit logs (PostgreSQL RULE prevents UPDATE/DELETE)
- **workers/main.py** — Celery tasks

The API is async-first (asyncpg + AsyncSessionLocal). Rate limiting via slowapi (200 req/min on sensitive endpoints).

### Frontend (platform/ui/src/)

- **App.jsx** — Routing and navigation
- **lib/api.js** — Fetch wrapper for all `/v1` calls
- **components/ui.jsx** — Shared UI primitives (buttons, inputs, modals)
- **pages/** — One file per page; see MEMORY.md for the full list
- **public/terminal.html** / **public/bandwidth.html** — Standalone popup pages; xterm.js is bundled inline (no CDN)

Styling: Tailwind CSS. Charts: Recharts. Icons: Lucide React.

### Agent (agent/)

- **agent.py** — asyncio entry point
- **core/connection.py** — Outbound WSS connection to server (no inbound ports required)
- **core/dispatcher.py** — Routes incoming task messages to task modules
- **core/monitor.py** — Heartbeat and telemetry
- **core/terminal.py** / **core/bandwidth.py** — Real-time browser↔agent bridges
- **core/updater.py** — Self-update with SHA256 verification
- **tasks/** — 29 task modules, each self-contained

The agent enrolls once using a secret, receives a JWT, then maintains a persistent WSS connection.

## Key Constraints

- **Do NOT modify `display.py`** or any display-related agent code.
- **Do NOT use CDN links** for any frontend libraries — all JS/CSS must be bundled inline (network is restricted).
- xterm.js is already bundled inline in `public/terminal.html`.
- Reports page currently covers only 9 of the 29 task types.
- There is no pytest setup — integration testing is done via `test_flow.py`.
