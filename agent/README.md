# MSP Agent

Lightweight diagnostics agent for Linux devices managed by the MSP platform.
Connects outbound to the MSP server over WSS (port 443) — no inbound connectivity required.

**Supported platforms:** Raspberry Pi OS (Bullseye / Bookworm), Debian 11/12, Ubuntu 22.04/24.04
**Supported architectures:** x86_64, aarch64, armv7l, armv6l

---

## Installation

Copy the `msp-agent` folder to the target device and run the installer:

```bash
# 1. Copy the msp-agent folder to the device
scp -r msp-agent/ user@<device-ip>:/home/user/

# 2. SSH in and run the installer
ssh user@<device-ip>
cd /home/user/msp-agent
sudo bash install.sh \
  --server https://yourserver.com \
  --secret <enrollment_secret_from_portal>
```

The enrollment secret is generated when you create a device slot in the MSP portal (`POST /v1/devices`). It is single-use and consumed on successful enrollment.

---

## What install.sh does

1. Installs system packages: `nmap`, `python3`, `python3-pip`, `wireless-tools`
2. Installs Python packages: `websockets`
3. Creates a locked-down `msp-agent` system user
4. Writes config to `/etc/msp-agent/config.json`
5. Copies agent files to `/opt/msp-agent/`
6. Installs and enables the `msp-agent` systemd service
7. Starts the service — enrollment happens automatically on first run

---

## File Layout

```
/opt/msp-agent/         Agent source files
/etc/msp-agent/         Config (config.json)
/var/log/msp-agent/     Log files
/usr/local/bin/msp-agent  Launcher script
/etc/systemd/system/msp-agent.service
```

---

## Useful Commands

```bash
# Service status
systemctl status msp-agent

# Live logs (journal)
journalctl -u msp-agent -f

# Live logs (file)
tail -f /var/log/msp-agent/agent.log

# Restart
systemctl restart msp-agent

# Stop
systemctl stop msp-agent

# View config
cat /etc/msp-agent/config.json
```

---

## Supported Tasks

| Task Type | Description |
|-----------|-------------|
| `run_nmap_scan` | Full nmap scan with XML parsing. Payload: `targets[]`, `ports`, `scan_type` (quick/service/os) |
| `run_port_scan` | Fast async TCP connect scan, no root required. Payload: `target`, `ports`, `timeout`, `concurrency` |
| `run_ping_sweep` | ICMP sweep of a CIDR network. Payload: `network`, `timeout`, `concurrency` |
| `get_sysinfo` | CPU, memory, disk, temp, WiFi signal, interfaces, DNS. No payload needed |
| `run_speedtest` | Download speed + latency. Uses speedtest-cli or HTTP fallback. Payload: `method` |

---

## Self-Update Flow

When the server pushes an `update_available` message:

1. Agent reports `downloading`
2. Downloads new binary from server (authenticated)
3. Verifies SHA256 — aborts if mismatch
4. Reports `applying`
5. Backs up current binary to `/opt/msp-agent/msp-agent.bak`
6. Atomically replaces `/usr/local/bin/msp-agent`
7. Reports `completed`
8. Restarts via `systemctl restart msp-agent`

On any failure, restores backup and reports `rolled_back`.

---

## Config Reference

`/etc/msp-agent/config.json`

| Key | Description |
|-----|-------------|
| `server_url` | WebSocket server URL e.g. `wss://yourserver.com` |
| `api_base` | HTTP API base e.g. `https://yourserver.com` |
| `device_id` | Set automatically after enrollment |
| `access_token` | JWT, set automatically after enrollment |
| `enrollment_secret` | One-time secret, cleared after enrollment |
| `version` | Current agent version |
| `heartbeat_interval` | Seconds between heartbeats (default 30) |
| `reconnect_min` | Min reconnect backoff seconds (default 5) |
| `reconnect_max` | Max reconnect backoff seconds (default 300) |
| `log_level` | DEBUG / INFO / WARNING / ERROR |
| `log_file` | Path to log file |
