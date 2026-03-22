# TekNaBox — Server

FastAPI backend for the TekNaBox RMM platform. Deployed via Docker Compose from the `platform/` directory — see the [platform README](../README.md) for setup and deployment instructions.

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
   │   (4 Uvicorn workers)   │     │             │
   └────────────┬────────────┘     └─────────────┘
                │                        ▲
   ┌────────────▼────────────┐           │
   │  Background Workers     │───────────┘
   │  (task watchdog,        │
   │   heartbeat monitor,    │     ┌─────────────┐
   │   update scheduler)     │────▶│    Redis    │
   └─────────────────────────┘     │  (pub/sub)  │
                                    └─────────────┘
```

TLS is handled entirely by Nginx Proxy Manager. The API container listens on plain HTTP internally.

### Communication Model

Devices maintain a **persistent WebSocket** over TLS to `/v1/devices/channel`. The server pushes tasks and configuration through this channel; the device pushes telemetry, task results, heartbeats, and monitor results back. No inbound connectivity to the device is required.

---

## Tenant Hierarchy

```
MSPOrganization
  └── CustomerOrganization(s)
        └── Site(s)
              └── Device(s)
```

Every DB query filters by `msp_id` at the application layer. No cross-tenant data access is possible from the API.

---

## Testing

A single script (`test_flow.py`) exercises the full API lifecycle against a running server. It creates all tenant data, enrolls a device, exercises tasks and updates, then cleans up.

```bash
# Install test dependencies
pip install httpx websockets rich

# Run against local stack (started from platform/ with docker compose up -d)
python test_flow.py --base-url http://localhost:8005

# Override super admin credentials
SUPER_ADMIN_EMAIL=admin@myco.com SUPER_ADMIN_PASSWORD=MyPass123 python test_flow.py
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
| 9 | Device enrollment (simulates agent) |
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

### Interactive Docs (Swagger UI)

Set `ENVIRONMENT=development` in `platform/.env`, rebuild the api container, then visit `http://localhost:8005/docs`.

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
  "current_version": "1.0.0"
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
  "timeout_seconds": 300
}
```

#### `GET /v1/devices/{id}/tasks`
Retrieve task history for a device.

---

### Update Management

#### `POST /v1/releases`  (multipart)
Upload a new agent artifact. Fields: `version`, `arch`, `channel`, `is_mandatory`, `release_notes`. File: `artifact`.

The server computes SHA-256 of the artifact and stores it. Devices verify this hash before applying.

#### `POST /v1/releases/{id}/rollout`
Trigger phased rollout. Parameters:
- `rollout_percent` (1–100): percentage of eligible devices
- `is_forced`: override device deferral
- `customer_id` / `site_id` / `device_id`: scope the rollout

#### `POST /v1/releases/{id}/revoke`
Immediately deactivate a release and cancel all pending jobs.

---

### Device WebSocket Channel

```
wss://server/v1/devices/channel?token=<device_jwt>
```

**Device → Server messages:**
| type | description |
|------|-------------|
| `heartbeat` | `{ version, uptime_seconds, cpu_temp_c, memory, disk }` |
| `task_result` | `{ id, success, result, error }` |
| `monitor_result` | `{ results: [{ monitor_id, success, rtt_ms, error, ... }] }` |
| `update_status` | `{ job_id, status, version, error }` |
| `pong` | keepalive response |

**Server → Device messages:**
| type | description |
|------|-------------|
| `task` | `{ id, task_type, payload, timeout_seconds }` |
| `monitor_config` | `{ monitors: [...] }` — pushed on every connect |
| `update_available` | `{ job_id, version, sha256, size_bytes, forced, download_url }` |
| `ping` | keepalive |
| `kill` | `{ reason }` — device must cease operation |

---

### Audit Logs

#### `GET /v1/audit`
Returns immutable audit trail for the operator's MSP. Filterable by `device_id`.

Audit log rows are write-once — PostgreSQL `RULE` prevents UPDATE/DELETE.

Tracked actions: `device_enrolled`, `device_revoked`, `task_issued`, `update_deployed`, `update_revoked`, `config_changed`, `operator_login`, `operator_created`, `operator_revoked`.

---

## Security Notes

- **Device identity**: Enrollment secret is one-time-use and SHA-256 hashed at rest. Post-enrollment, devices authenticate with short-lived JWTs signed by `DEVICE_TOKEN_SECRET`.
- **Revocation**: Immediately sets status=REVOKED, sends `kill` over WebSocket, all future token validations check DB status.
- **Artifact integrity**: SHA-256 computed server-side on upload; included in update notification and download response header. Device verifies before applying.
- **Audit immutability**: PostgreSQL `RULE` blocks UPDATE/DELETE on `audit_logs`.
- **Tenant isolation**: Every query includes `msp_id = operator.msp_id`. No shared query paths between tenants.

---

## Project Structure

```
server/
├── app/
│   ├── api/v1/
│   │   ├── enrollment.py       # Device enrollment & token refresh
│   │   ├── device_channel.py   # WebSocket handler + monitor results
│   │   ├── management.py       # Devices, tasks, releases
│   │   ├── monitors.py         # Uptime monitor CRUD + check history
│   │   ├── admin.py            # Operators, MSPs
│   │   ├── security.py         # Security Hub scans
│   │   └── ...
│   ├── core/
│   │   ├── auth.py             # JWT dependencies
│   │   ├── config.py           # Pydantic settings (reads from env)
│   │   ├── database.py         # Async SQLAlchemy engine
│   │   └── security.py         # Crypto utilities
│   ├── models/
│   │   └── models.py           # All SQLAlchemy ORM models
│   ├── services/
│   │   ├── audit.py            # Audit log writer
│   │   ├── connection_manager.py  # WebSocket + Redis pub/sub
│   │   └── mailer.py           # SMTP alert emails
│   ├── workers/
│   │   └── main.py             # Background task workers
│   └── main.py                 # FastAPI app + lifespan
├── docker/
│   └── Dockerfile.api
└── requirements.txt
```
