# MSP Remote Diagnostics Platform — Server

A production-grade, multi-tenant server for managing fleets of headless Raspberry Pi Zero devices deployed inside customer networks. All communication occurs over standard HTTPS/WebSocket on **TCP port 443**, fully encrypted, client-initiated outbound only.

---

## Architecture Overview

```
Internet / MSP Network
        │
        ▼ TCP 443 (TLS)
   ┌─────────────────────────────┐
   │   Nginx Proxy Manager (NPM) │  TLS termination, cert management,
   │   (external, not in stack)  │  WebSocket proxying
   └────────────┬────────────────┘
                │ HTTP → :8000
   ┌────────────▼────────────┐     ┌─────────────┐
   │   FastAPI (API)         │────▶│  PostgreSQL  │
   │   (N replicas)          │     │  (primary)  │
   └────────────┬────────────┘     └─────────────┘
                │                        ▲
   ┌────────────▼────────────┐           │
   │  Background Workers     │───────────┘
   │  (task watchdog,        │
   │   heartbeat mon,        │     ┌─────────────┐
   │   update scheduler)     │────▶│    Redis    │
   └─────────────────────────┘     │  (pub/sub)  │
                                    └─────────────┘
```

> **TLS is handled entirely by Nginx Proxy Manager (NPM)**, which runs outside this stack. NPM terminates SSL/TLS on port 443 and forwards plain HTTP to the API container on port 8000. No certificates or nginx config are needed inside this project.

### Communication Model

Raspberry Pi devices maintain a **persistent WebSocket** over TLS to `/v1/devices/channel`. The server pushes tasks and update notifications through this channel; the device pushes telemetry, task results, and heartbeats back. No inbound connectivity to the device is required.

For environments where WebSockets are blocked (deep-packet-inspection proxies), the enrollment and telemetry paths also support standard HTTPS polling.

---

## Tenant Hierarchy

```
MSPOrganization
  └── CustomerOrganization(s)
        └── Site(s)
              └── Device(s)
```

Every DB query filters by `msp_id` at the application layer. No cross-tenant data access is architecturally possible from the API.

---

## Testing

### End-to-End Test Script

A single script (`test_flow.py`) exercises the full API lifecycle against a running server. It requires no manual setup — it creates all tenant data, enrolls a device, exercises tasks and updates, then cleans up.

**Install test dependencies:**
```bash
pip install httpx websockets rich
```

**Run against local stack:**
```bash
# Start the server first
docker compose up -d

# Run the tests
python test_flow.py

# Or point at a remote server
python test_flow.py --base-url http://your-server:8000
```

**What it covers (19 steps):**

| Step | Test |
|------|------|
| 1 | Health check |
| 2 | Bootstrap super admin (one-time) |
| 3 | Super admin login |
| 4 | Create MSP organization |
| 5 | Create MSP admin operator |
| 6 | MSP admin login |
| 7 | Create customer + site |
| 8 | Create device slot → enrollment secret |
| 9 | Device enrollment (simulates Pi) |
| 10 | Verify device status = active |
| 11 | Issue task to device |
| 12 | WebSocket: connect, receive task, send result + telemetry |
| 13 | Verify task completed in DB |
| 14 | Upload client release artifact |
| 15 | Trigger phased rollout |
| 16 | Simulate full update status progression over WebSocket |
| 17 | Revoke device → verify kill signal received |
| 18 | Verify revoked device blocked from reconnecting |
| 19 | Fetch and display audit log |

**Override the default super admin credentials:**
```bash
SUPER_ADMIN_EMAIL=admin@myco.com SUPER_ADMIN_PASSWORD=MyPass123 python test_flow.py
```

### Interactive Docs (Swagger UI)

Set `ENVIRONMENT=development` in `.env`, restart, then visit:
```
http://localhost:8000/docs
```

The OpenAPI schema is always available at `http://localhost:8000/openapi.json` for import into Postman or Insomnia.



### Prerequisites
- Docker + Docker Compose
- Nginx Proxy Manager (running separately) configured to forward `yourdomain.com → http://<host>:8000`
  - Enable **WebSockets Support** in the NPM proxy host settings

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env — fill in all CHANGE_ME values

# 2. Start the stack
docker compose up -d

# 3. Verify (NPM handles HTTPS externally; test plain HTTP locally)
curl http://localhost:8005/health
# → {"status":"ok"}
```

### Nginx Proxy Manager Setup

In NPM, create a **Proxy Host** with:
- **Domain**: your server's hostname
- **Scheme**: `http`
- **Forward Hostname/IP**: the Docker host IP (or `host.docker.internal`)
- **Forward Port**: `8005`
- ✅ **WebSockets Support** — required for device channel
- SSL tab: assign your certificate (Let's Encrypt recommended)

---

## API Reference

### Authentication

All operator endpoints require `Authorization: Bearer <token>` (JWT).
All device endpoints require `Authorization: Bearer <device_token>` or `?token=<device_token>` (WebSocket).

#### `POST /v1/auth/login`
```json
{ "email": "admin@msp.com", "password": "..." }
```
Returns `access_token`.

---

### Device Lifecycle

#### `POST /v1/devices`
Create a device slot and generate a one-time enrollment secret.
```json
{ "name": "site-a-device-01", "site_id": "...", "role": "diagnostic" }
```
Returns `{ device_id, enrollment_secret }` — **enrollment_secret shown once**.

#### `POST /v1/enroll`
Called **by the device** with the enrollment secret. Returns a device JWT.
```json
{
  "enrollment_secret": "...",
  "hardware_id": "cpu-serial",
  "arch": "armv6l",
  "current_version": "1.0.0",
  "cert_fingerprint": "sha256:..."
}
```

#### `POST /v1/devices/{id}/revoke`
Immediately revokes a device. Sends `{"type":"kill"}` over WebSocket if connected. Revoked devices are refused future connections.

#### `GET /v1/devices`
List devices. Filterable by `customer_id`, `site_id`, `status`.

---

### Task Orchestration

#### `POST /v1/devices/{id}/tasks`
Queue a task. Delivered immediately if device is connected; otherwise queued for next connection.
```json
{
  "task_type": "run_nmap_scan",
  "payload": { "targets": ["10.0.0.0/24"], "ports": "1-1024" },
  "timeout_seconds": 300,
  "idempotency_key": "scan-2025-01-15"
}
```

#### `GET /v1/devices/{id}/tasks`
Retrieve task history for a device.

---

### Update Management

#### `POST /v1/releases`  (multipart)
Upload a new client binary artifact. Fields: `version`, `arch`, `channel`, `is_mandatory`, `release_notes`. File: `artifact`.

The server computes SHA-256 of the artifact and stores it. Devices verify this hash before applying.

#### `POST /v1/releases/{id}/rollout`
Trigger phased rollout. Parameters:
- `rollout_percent` (1-100): percentage of eligible devices
- `is_forced`: override device deferral
- `customer_id` / `site_id` / `device_id`: scope the rollout

#### `POST /v1/releases/{id}/revoke`
Immediately deactivate a release and cancel all pending jobs.

#### `GET /v1/client/updates/{release_id}/artifact`  *(device auth)*
Streaming download of the update binary. Includes `X-Artifact-SHA256` header.

---

### Device WebSocket Channel

```
wss://server/v1/devices/channel?token=<device_jwt>
```

**Device → Server messages:**
| type | description |
|------|-------------|
| `heartbeat` | `{ version, uptime_seconds, ... }` |
| `task_result` | `{ id, success, result, error }` |
| `telemetry` | `{ telemetry_type, task_id, data }` |
| `update_status` | `{ job_id, status, version, error, rollback_reason }` |
| `pong` | keepalive response |

**Server → Device messages:**
| type | description |
|------|-------------|
| `task` | `{ id, task_type, payload, timeout_seconds }` |
| `update_available` | `{ job_id, version, sha256, size_bytes, forced, download_url }` |
| `ping` | keepalive (device responds with `pong`) |
| `kill` | `{ reason }` — device must cease operation |

---

### Update Status Flow (Device Reports)

```
PENDING → NOTIFIED → DOWNLOADING → APPLYING → COMPLETED
                                      └──────→ FAILED → (retry or ROLLED_BACK)
```

The device is responsible for:
1. Downloading artifact to temp path
2. Verifying SHA-256 before applying
3. Using A/B or atomic swap (e.g. `/usr/local/bin/agent.new` → rename)
4. Reporting `COMPLETED` with new version on success
5. Reporting `ROLLED_BACK` on failure with reason

---

### Audit Logs

#### `GET /v1/audit`
Returns immutable audit trail for the operator's MSP. Filterable by `device_id`.

Audit log rows are write-once — PostgreSQL `RULE` prevents UPDATE/DELETE.

Tracked actions: `device_enrolled`, `device_revoked`, `task_issued`, `update_deployed`, `update_revoked`, `config_changed`, `operator_login`, `operator_created`, `operator_revoked`.

---

## Scalability

The API tier is **fully stateless** — no local filesystem state, no in-memory session state beyond WebSocket connections. WebSocket messages are relayed across API instances via **Redis pub/sub**, so any instance can send a message to any device regardless of which instance holds the connection.

For Kubernetes deployment:
- Deploy API as `Deployment` with HPA on CPU/connection count
- Use `SessionAffinity: ClientIP` or a sticky load balancer for WebSocket connections (preferred), or rely fully on Redis relay
- PostgreSQL via managed service (RDS, Cloud SQL) with connection pooling (PgBouncer)
- Redis via managed service (ElastiCache, Memorystore)
- Artifacts via S3-compatible object storage — replace `FileResponse` with presigned URL redirect

---

## Security Notes

- **Device identity**: Enrollment secret is one-time-use and SHA-256 hashed at rest. Post-enrollment, devices authenticate with short-lived JWTs signed by a separate `DEVICE_TOKEN_SECRET`.
- **Revocation**: `revoke_device` immediately sets status=REVOKED, sends `kill` over WebSocket, and all future token validations check DB status.
- **Artifact integrity**: SHA-256 computed server-side on upload; included in update notification and download response header. Device MUST verify before applying.
- **Audit immutability**: PostgreSQL `RULE` blocks UPDATE/DELETE on `audit_logs`. Rotate to append-only storage (e.g. TimescaleDB, S3) for long-term retention.
- **Tenant isolation**: Every query includes `msp_id = operator.msp_id`. No shared query paths exist between tenants.

---

## Project Structure

```
msp-server/
├── app/
│   ├── api/v1/
│   │   ├── enrollment.py      # Device enrollment & token refresh
│   │   ├── device_channel.py  # WebSocket handler
│   │   └── management.py      # Operator API (devices, tasks, releases)
│   ├── core/
│   │   ├── auth.py            # JWT dependencies
│   │   ├── config.py          # Pydantic settings
│   │   ├── database.py        # Async SQLAlchemy engine
│   │   └── security.py        # Crypto utilities
│   ├── models/
│   │   └── models.py          # Full SQLAlchemy data model
│   ├── services/
│   │   ├── audit.py           # Audit log writer
│   │   ├── connection_manager.py  # WebSocket + Redis pub/sub
│   │   └── update_service.py  # Update rollout & state tracking
│   ├── workers/
│   │   └── main.py            # Background task workers
│   └── main.py                # FastAPI app + lifespan
├── migrations/
│   └── 0001_initial.py
├── docker/
│   └── Dockerfile.api         # API container (TLS handled by NPM externally)
├── docker-compose.yml
├── requirements.txt
└── .env.example
```
