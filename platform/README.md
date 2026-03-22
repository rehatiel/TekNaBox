# TekNaBox — Platform

Complete Docker deployment — API + Worker + UI + Database + Cache.

## Directory Structure

```
platform/
├── docker-compose.yml    ← Single compose file for everything
├── .env                  ← Your secrets (copy from .env.example)
├── .env.example
├── server/               ← FastAPI backend
│   ├── app/
│   └── Dockerfile
└── ui/                   ← React frontend
    ├── src/
    ├── nginx.conf
    └── Dockerfile
```

## First-Time Setup

```bash
cd platform

# 1. Create your .env file
cp .env.example .env
# Edit .env — fill in passwords, generate SECRET_KEY:
# python3 -c "import secrets; print(secrets.token_hex(32))"

# 2. Build and start
docker compose build
docker compose up -d

# 3. Verify everything is running
docker compose ps
docker compose logs api --tail=20
```

## Services

| Service  | Host Port | Purpose |
|----------|-----------|---------|
| `ui`     | **3005**  | nginx — serves React UI + proxies `/v1` to API |
| `api`    | **8005**  | FastAPI backend |
| `worker` | —         | Celery background task processor |
| `db`     | internal  | PostgreSQL 16 |
| `redis`  | internal  | Redis 7 — Celery broker + pub/sub |

## Nginx Proxy Manager Setup

Two proxy host entries:

**UI (web dashboard)**
```
Domain:       yourserver.com
Forward Host: <server-ip>
Forward Port: 3005
WebSockets:   ✅ Enabled
SSL:          Let's Encrypt
```

**API (agent WebSocket connections)**
```
Domain:       tekn-api.yourserver.com
Forward Host: <server-ip>
Forward Port: 8005
WebSockets:   ✅ Enabled  ← Critical for agent connections
SSL:          Let's Encrypt
```

> WebSocket support must be enabled on the API proxy host or agent connections will fail.

## Agent Installation

Once your domain is configured, enroll a device:

1. In the UI: **Devices → Add Device** — creates an enrollment record and provides a secret.
2. On the target Linux device:

```bash
scp -r agent/ user@device:/home/user/
ssh user@device
sudo bash /home/user/agent/install.sh \
  --server https://tekn-api.yourserver.com \
  --secret <enrollment_secret>
```

The agent installs as a systemd service (`teknabox-agent`) and connects outbound only.

## Useful Commands

```bash
# View logs
docker compose logs -f
docker compose logs api -f

# Rebuild and restart a service after code changes
docker compose build api && docker compose up -d api
docker compose build ui && docker compose up -d ui

# Restart a service
docker compose restart api

# Stop everything
docker compose down

# Stop and wipe database (destructive)
docker compose down -v
```
