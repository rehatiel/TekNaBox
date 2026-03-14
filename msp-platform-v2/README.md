# MSP Command Platform

Complete deployment package — API + Worker + UI + Database + Cache.

## Directory Structure

```
msp-platform/
├── docker-compose.yml    ← Single compose file for everything
├── .env                  ← Your secrets (copy from .env.example)
├── .env.example
├── msp-server/           ← FastAPI backend (copy from msp-server.zip)
│   ├── app/
│   ├── docker/
│   │   └── Dockerfile.api
│   └── ...
└── msp-ui/               ← React frontend (copy from msp-ui.zip)
    ├── src/
    ├── docker/
    │   └── nginx.conf
    ├── Dockerfile
    └── ...
```

## First-Time Setup

```bash
# 1. Create the platform directory
mkdir msp-platform && cd msp-platform

# 2. Extract both zips here
unzip msp-server.zip
unzip msp-ui.zip

# 3. Copy this docker-compose.yml and .env.example here too

# 4. Create your .env file
cp .env.example .env
nano .env   # Fill in strong passwords and generated secrets

# Generate secrets with:
python3 -c "import secrets; print(secrets.token_hex(32))"

# 5. Build and start
docker compose build
docker compose up -d

# 6. Check everything is running
docker compose ps
docker compose logs ui --tail=20
```

## Services

| Service | Internal | External | Purpose |
|---------|----------|----------|---------|
| `ui`    | port 80  | **3000** | nginx — serves React UI + proxies /v1 to API |
| `api`   | port 8000| none     | FastAPI backend (internal only) |
| `worker`| —        | none     | Background task processor |
| `db`    | port 5432| none     | PostgreSQL (internal only) |
| `redis` | port 6379| none     | Redis pub/sub (internal only) |

Only **port 3000** is exposed. Everything else is internal.

## Nginx Proxy Manager Setup

Point NPM at the `ui` service on port 3000:

```
Domain:       yourserver.com
Forward Host: <your-host-ip>
Forward Port: 3000
WebSockets:   ✅ Enabled   ← Critical for Pi device connections
SSL:          Let's Encrypt (NPM handles it)
```

That's it — one NPM entry handles both the web UI and WebSocket device connections.

## Pi Agent Installation

Once NPM is configured with your domain:

```bash
# On the server — create a device slot first
curl -s -X POST https://yourserver.com/v1/devices \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"pi-zero-01","site_id":"<site_id>","role":"diagnostic"}' \
  | python3 -m json.tool

# On the Pi
sudo bash install.sh \
  --server https://yourserver.com \
  --secret <enrollment_secret>
```

## Useful Commands

```bash
# View all logs
docker compose logs -f

# View specific service
docker compose logs api -f
docker compose logs ui -f

# Restart a service
docker compose restart api

# Rebuild after code changes
docker compose build ui && docker compose up -d ui

# Stop everything
docker compose down

# Stop and wipe database (careful!)
docker compose down -v
```
