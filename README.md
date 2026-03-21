# TekNaBox — MSP Remote Management Platform

A self-hosted Remote Monitoring & Management (RMM) platform built for Managed Service Providers. Run network diagnostics, security audits, and real-time terminal sessions on remote Linux devices — all from a single browser-based dashboard.

---

## Features

### Device Management
- Enroll Linux agents via a one-line install command using a pre-shared secret
- Multi-tenant hierarchy: **MSP → Customer → Site → Device**
- Live online/offline status via persistent WebSocket heartbeat
- Role-based access: `super_admin`, `msp_admin`, `msp_operator`, `customer_viewer`

### Network Discovery
- Continuous background ARP scanning with configurable intervals (30s – 5m)
- Interface auto-detection from agent sysinfo
- Interactive zoomable/pannable network diagram with per-node detail panels
- Known/unknown device classification persisted across sessions
- **Device History page** — persistent server-side record of every device ever seen, with first/last-seen timestamps, inline label editing, and search

### 29 Remote Task Types

| Category | Tasks |
|---|---|
| System | sysinfo, speedtest, HTTP monitor, NTP check |
| Network discovery | ping sweep, ARP scan, Nmap scan, port scan, NetBIOS scan, LLDP neighbors, wireless survey, Wake-on-LAN |
| Diagnostics | DNS lookup, traceroute, MTR, iPerf, banner grab, packet capture, SNMP query |
| Security | SSL/TLS check, DNS health, vuln scan, security audit, default credentials, cleartext services, SMB enum, email breach |
| Active Directory | AD discovery, full AD recon |

### Security & Auditing
- Findings workflow with acknowledge/delete and severity levels (critical → info)
- Write-once audit log (PostgreSQL RULE prevents UPDATE/DELETE)
- JWT authentication with rate limiting on sensitive endpoints
- Security Hub for on-demand scans across multiple task types

### Live Sessions
- **Browser terminal** — full xterm.js shell bridged over WebSocket to the remote agent
- **Bandwidth monitor** — real-time throughput graphs streamed from the agent

### Monitoring
- Uptime monitoring with configurable targets and RTT history charts
- Device online/offline timeline

### Reporting
- Reports page with dedicated renderers for all major task types
- Hide background scans filter to keep the view clean
- Wireless Survey page with signal-strength visualisation
- AD Report with full Active Directory analysis (users, groups, GPOs, delegation, DHCP, LAPS, security principals)

---

## Architecture

```
Browser ──HTTPS──▶ Nginx Proxy Manager ──▶ ┌─────────────┐
                                            │  api (8005) │ FastAPI + 4 Uvicorn workers
                                            │  ui  (3005) │ React via nginx
                                            │  worker     │ Celery background tasks
                                            │  db  (5432) │ PostgreSQL 16
                                            │  redis      │ Redis 7 (broker + pub/sub)
                                            └─────────────┘
                                                   │ WSS
                                            Remote Linux Device
                                            └── teknabox-agent (outbound WSS only)
```

The agent connects **outbound only** — no inbound ports are required on the client device. WebSocket messages are relayed through Redis pub/sub so any API worker instance can reach any connected agent.

---

## Prerequisites

**Server**
- Docker + Docker Compose
- Nginx Proxy Manager (or any reverse proxy) with WebSocket support enabled
- A domain name with valid TLS certificate

**Agent (per device)**
- Linux (Debian / Ubuntu / Raspberry Pi OS)
- Python 3.10+
- System packages: `nmap`, `arp-scan`, `net-tools`, `iputils-ping`, `iproute2`, `tcpdump`, `snmp`, `iperf3`

---

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/yourname/teknabox.git
cd teknabox/platform
cp server/.env.example server/.env
```

Edit `server/.env`:

```env
DATABASE_URL=postgresql+asyncpg://teknabox:yourpass@db/teknabox
REDIS_URL=redis://redis:6379/0
SECRET_KEY=<generate with: python -c "import secrets; print(secrets.token_hex(32))">
BOOTSTRAP_EMAIL=admin@yourmsp.com
BOOTSTRAP_PASSWORD=<strong password>
ENVIRONMENT=production
```

### 2. Start the stack

```bash
docker compose up -d
```

The UI is available at `http://localhost:3005` and the API at `http://localhost:8005`.

Point your reverse proxy to these ports and enable WebSocket proxying for the API.

### 3. First login

Navigate to your configured domain and sign in with the `BOOTSTRAP_EMAIL` / `BOOTSTRAP_PASSWORD` you set. This super admin account is only created once (skipped if operators already exist).

### 4. Enroll your first device

1. In the UI: go to **Devices → Add Device** and create an enrollment record to get an enrollment secret.
2. On the target Linux device:

```bash
scp -r agent/ user@device:/home/user/
ssh user@device
sudo bash /home/user/agent/install.sh \
  --server https://your-api-domain.com \
  --secret <enrollment_secret>
```

The agent installs as a systemd service, enrolls once, and maintains a persistent outbound connection.

---

## Development

### Backend

```bash
cd platform
# Rebuild and restart after code changes
docker compose build api && docker compose up -d api

# Tail logs
docker compose logs -f api

# Enable Swagger docs (set in .env)
ENVIRONMENT=development
# Then visit http://localhost:8005/docs
```

Run the integration test suite (19 steps — health, auth, enroll, task dispatch, updates, audit):

```bash
cd platform/server
python test_flow.py --base-url http://localhost:8000
```

### Frontend

```bash
cd platform/ui
npm install
npm run dev   # Dev server on :5173, proxies /v1 to localhost:8005
npm run build # Production build → dist/
```

> **Note:** All JavaScript libraries must be bundled locally — no CDN links. The deployment environment has restricted outbound network access.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI, SQLAlchemy (async), asyncpg |
| Task queue | Celery + Redis |
| Database | PostgreSQL 16 |
| Frontend | React 18, Vite, Tailwind CSS |
| Charts | Recharts |
| Terminal | xterm.js (bundled inline) |
| Icons | Lucide React |
| Agent | Python asyncio, websockets |
| Infra | Docker Compose, Nginx |

---

## Project Structure

```
teknabox/
├── platform/
│   ├── docker-compose.yml
│   ├── server/
│   │   ├── app/
│   │   │   ├── api/v1/          # FastAPI routers
│   │   │   ├── core/            # Auth, config, database, security
│   │   │   ├── models/          # SQLAlchemy ORM models
│   │   │   ├── services/        # Connection manager, audit
│   │   │   └── workers/         # Celery tasks
│   └── ui/
│       └── src/
│           ├── components/      # Shared UI primitives + Sidebar
│           ├── hooks/           # useAuth, useTheme, useTaskPoll
│           ├── lib/             # api.js fetch wrapper
│           └── pages/           # One file per page (20 pages)
└── agent/
    ├── agent.py                 # asyncio entry point
    ├── core/                    # Connection, dispatcher, monitor, terminal, bandwidth, updater
    ├── tasks/                   # 29 task modules
    └── install.sh               # systemd service installer
```

---

## License

This project is released under the **Teknabox Source Available License**. See [LICENSE](LICENSE) for full terms.

**In short:** you may use, run, and modify this software freely for personal or commercial purposes. You may not sell, resell, or commercially distribute it as a product or service without prior written approval.
