# MSP Platform — Build State

Last updated: 2026-03-09

## Infrastructure
- **Platform repo:** `/home/claude/msp-platform-v2/`
- **Agent repo:** `/home/claude/msp-agent-v2/`
- **Server URL:** `https://tekn-api.synhow.com` / `wss://tekn-api.synhow.com`
- **Pi device_id:** `f7be66db-bc21-4fc4-ab51-d90d26daa042`
- **Pi hardware_id:** `93949c77e57eac2b`
- **Pi hostname:** `debby-unknown`
- **Fresh server deploy assumed** — schema created from scratch, no migrations needed
- **Do NOT modify** `display.py` or any display-related agent code

## Output Zips
- `/mnt/user-data/outputs/msp-command-phase4.zip` — full platform (server + UI + agent), current canonical build
- `/mnt/user-data/outputs/msp-agent-v2.zip` — agent only

> All previous patch zips are superseded by `msp-command-phase4.zip`.

## Dependency notes
- `recharts` already in `package.json` (`^2.12.0`)
- **Do NOT use CDN for frontend libraries** — network is restricted; install via npm and bundle inline if needed
- xterm.js is bundled inline in `terminal.html` (not CDN) due to this restriction

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Pi Task Expansion (19 tasks) | ✅ Complete |
| 2 | Live Bandwidth Streaming | ✅ Complete |
| 3 | Remote Terminal Access | ✅ Complete |
| 4 | Uptime Monitoring | ✅ Complete |
| 4+ | Phase 4 Hardening + AD Overhaul | ✅ Complete |
| 5 | SNMP UI (dedicated page) | ✅ Complete |
| 6 | Security/Vuln Scanning UI | ✅ Complete |
| 7 | UI Additions (Tasks page, Dashboard) | ✅ Complete |
| 8 | AD Recon | ✅ Complete |
| — | User Management | ✅ Complete |

---

## Phase 4+ — Hardening, Agent Fixes, AD Report Overhaul (✅ Complete, 2026-03-08)

### Agent bug fixes
- `tasks/security_audit.py` — rewritten with `asyncio.gather` + `Semaphore(10)` for concurrent checks
- `tasks/packet_capture.py` — single tshark capture to temp pcap, stats computed post-process
- `core/hardware.py` — `get_arch()` uses `@functools.lru_cache(maxsize=1)` + `platform.machine()`
- `tasks/ad_recon.py` — credentials scrubbed from payload immediately on entry
- `tasks/ad_discover.py` — `_enum4linux_basic()` replaced with `nmblookup`/`smbclient` implementation
- `tasks/ssl_check.py` — fixed `lstrip("https://")` bug → `startswith`/`removeprefix` pattern (lstrip treated argument as a character set, stripping leading chars like `s` from hostnames like `synacktime.com`)

### New: core/monitor.py
- Was referenced in `connection.py` but never existed — caused `No module named 'core.monitor'` crash on every agent connect
- Implements background uptime monitoring loop: pings configured targets concurrently (`Semaphore(20)`), tries TCP connect to 443/80 then falls back to system ping, sends `monitor_result` messages back to server

### Server hardening
- `list_devices`: limit defaults to 200, max 500, with `offset` pagination, `ORDER BY created_at DESC`
- `issue_task`: returns `warning` field when device is OFFLINE rather than silently queuing
- `GET /v1/task-types` already had auth

### DB migration
- `migrations/0002_phase2_tables.py`: `IF NOT EXISTS` guards on all new tables — safe on existing DBs

### UI completions
- `DeviceDetail.jsx` TASK_GROUPS: all 29 tasks across 6 groups (System, Network Discovery, Diagnostics, SNMP, Security, Active Directory). Password fields render as `type="password"`. Offline warning surfaced as amber alert.
- `Tasks.jsx`: live fetch from `GET /v1/task-types` on mount with 29-type fallback
- `Dashboard.jsx`: `getAllTasks` limit raised to 200; added `tasks24h`, `failedTasks24h`, `highFindings` stat cards

### install.sh fix
- Changed `cp -r` to `rm -rf` then `cp -r` for `tasks/` and `core/` — prevents stale files from old installs persisting

### Bug fix (v3.1.0, 2026-03-08)
- `Device` model was missing the `customer` ORM relationship — only the FK column existed. `selectinload(Device.customer)` in `list_devices` raised `AttributeError`, returning 500 on every `GET /v1/devices`
- Fix: added `customer: Mapped[Optional["CustomerOrganization"]] = relationship(foreign_keys=[customer_id])` to the `Device` model

### AD Report overhaul
- New top-level nav link (`/ad-report`) with device selector dropdown — device picker groups by `customer_name` using `<optgroup>`
- `customer_name` added to `GET /v1/devices` response via `selectinload(Device.customer)` in `list_devices`
- `Device.customer` ORM relationship added to models.py with `foreign_keys=[customer_id]`
- New **Infrastructure** tab: domain overview, all DCs (OS/hardware/FSMO roles/GC status/site), trust relationships, DNS zones (both AD partitions), DHCP scopes, OU tree with GPO link counts
- New **GPOs** tab: searchable list with status, modification date, linked OUs via reverse `gPLink` lookup
- `tasks/ad_recon.py` expanded from 6 → 12 parallel collection functions:
  - `_get_dc_list` — all DCs with OS, FSMO roles, GC status, site, hostname→IP resolution
  - `_get_fsmo_roles` — Schema/PDC/RID/Infrastructure Master holders via correct LDAP naming contexts
  - `_get_dc_sites` — AD Sites and Services
  - `_get_trusts` — all trust relationships with direction, type, transitivity
  - `_get_dns_zones` — AD-integrated zones from DomainDnsZones and ForestDnsZones
  - `_get_dhcp_scopes` — DHCP server/scope enumeration via LDAP NetServices container
  - `_get_ous` — full OU tree with depth and GPO link counts
  - `_get_gpos` — all GPOs with status, linked OUs, modification date
- Password policy now collects history length, lockout observation window, lockout duration
- Findings engine: 4 new checks (domain passwords never expire, short history, no-password-required accounts, Enterprise Admins oversize)
- Privileged group enumeration: added Server Operators, Print Operators, Remote Desktop Users, Group Policy Creator Owners

---


## Vuln Scan Overhaul (✅ 2026-03-09)

### Agent `tasks/vuln_scan.py`
Full rewrite — see agent BUILD_STATE for details.

### Server `app/models/models.py`
- `ScanFinding` gains `cvss_score: Float` (nullable) — stores CVSS base score for vuln findings
- `Float` added to SQLAlchemy imports

### Server `app/api/v1/security.py`
- `save_scan_findings()` now stores `f.get("cvss")` → `cvss_score` column
- `_finding_dict()` returns `cvss_score` field

### Migration `migrations/0004_scan_findings_cvss.py`
- `ALTER TABLE scan_findings ADD COLUMN IF NOT EXISTS cvss_score FLOAT` — safe on existing DBs

### UI `msp-ui/src/pages/Findings.jsx`
- Findings table: CVE badge + `CVSS X.X` shown inline under finding title
- Detail drawer: CVSS score added to metadata grid (alongside CVE, Script, Port)
- New Scan modal: Port Scope selector (Top 100 / Top 500 / Top 1000) for vuln scans
- `top_ports` sent in vuln scan request body

## Session — AD Report Polish + Server Sync (✅ 2026-03-09)

### Agent (`tasks/ad_recon.py`)
- **DHCP bug fix** — `_get_dhcp_scopes()` was reconstructing LDAP server DN from the CN attribute value; fails when CN is an FQDN. Now uses the actual `dn` from LDAP directly. Also fixed multi-valued `dhcpRanges` handling; added `dhcpComment` and `dhcpSubnetMask` fields.
- **GPO SYSVOL parsing** — new `_fetch_gpo_settings()` downloads `GptTmpl.inf` via `smbget` for each GPO and parses it into structured sections: system access (password policy overrides), privilege rights (user rights with SE constants translated), event audit policy, restricted groups, and security options registry values. Stored in `gpo["details"]`.
- **New helper** — `_base_dn_from_domain()` replaces repeated inline DN construction.

### Server (`msp-server`)
- **`app/models/models.py`** — `ADReport` model gains 8 new nullable denormalised columns: `computer_count`, `unconstrained_delegation`, `laps_deployed`, `laps_coverage_pct`, `adminsdholder_count`, `protected_users_count`, `fine_grained_policies`, `service_accounts`
- **`app/api/v1/ad_recon.py`** — `save_ad_report()` populates all new summary columns from `result["summary"]`; `_report_summary()` returns them in list responses so sidebar badges work without loading the full report blob
- **`migrations/0003_ad_report_extended_summary.py`** (new) — `ALTER TABLE ad_reports ADD COLUMN IF NOT EXISTS` for all 8 new columns; nullable so existing reports are unaffected

### UI (`msp-ui/src/pages/ADReport.jsx`)
- **Stat cards** — split from one cramped 8-column row into two clean 4-column rows: Row 1 (inventory: Users/Computers/Domain Admins/Stale Accounts), Row 2 (risk: Kerberoastable/AS-REP Roastable/Unconstrained Deleg/LAPS Coverage)
- **LAPS Coverage card** — "Not deployed" was too long for the stat box; now shows "N/A" as the headline value with "Not deployed" as the small sub-label
- **Horizontal tab bar replaced** — 11 tabs were overflowing into a horizontal scroll. Replaced with a grouped vertical nav sidebar (w-44, border-r) with four labelled groups: SUMMARY / DIRECTORY / POLICY / SECURITY. No scrolling, scales to any number of sections.
- **New: Computers tab** — OS breakdown pills, stale/no-LAPS filter tabs, per-machine LAPS enrollment flag
- **New: Delegation tab** — unconstrained (red), constrained (with protocol-transition flag), RBCD split by type; green "all clear" state if nothing found
- **New: Security tab** — four sub-tabs: LAPS with coverage progress bar, AdminSDHolder table, Protected Users list, Service Accounts with MSA/gMSA/user type tagging
- **GPOs** — CSE tags now shown as coloured capability pills (computer/user config); version numbers; unlinked filter; `GPODetails` collapsible block renders parsed SYSVOL sections (audit policy, privilege rights, password policy overrides, restricted groups, security options)
- **Groups** — handles new `{members, nested_members, total_effective}` shape; backward-compatible with old flat array
- **Users** — Delegation filter tab; logon script column; `trusted_for_deleg`/`sensitive_no_deleg` flags
- **Password Policy** — PSOs rendered inline with precedence, applies-to tags, reversible-encryption warning
- **Shares** — permissions table with principal/rights/type columns; share-level ACL data from `rpcclient`
- **DHCP** — updated to render new shape (multiple ranges per scope, description, subnet mask)

---

## Phase 1 — Pi Task Expansion (✅ Complete)

All 19 task handlers in `msp-agent-v2/core/dispatcher.py`:

| Task type | Module |
|-----------|--------|
| `run_nmap_scan` | `tasks/nmap_scan.py` |
| `run_port_scan` | `tasks/port_scan.py` |
| `run_ping_sweep` | `tasks/ping_sweep.py` |
| `get_sysinfo` | `tasks/sysinfo.py` |
| `run_speedtest` | `tasks/speedtest.py` |
| `run_arp_scan` | `tasks/arp_scan.py` |
| `run_wireless_survey` | `tasks/wireless_survey.py` |
| `run_dns_lookup` | `tasks/dns_lookup.py` |
| `run_traceroute` | `tasks/traceroute.py` |
| `run_mtr` | `tasks/mtr_report.py` |
| `run_iperf` | `tasks/iperf_test.py` |
| `run_banner_grab` | `tasks/banner_grab.py` |
| `run_packet_capture` | `tasks/packet_capture.py` |
| `run_snmp_query` | `tasks/snmp_query.py` |
| `run_vuln_scan` | `tasks/vuln_scan.py` |
| `run_security_audit` | `tasks/security_audit.py` |
| `run_ad_discover` | `tasks/ad_discover.py` |
| `run_ad_recon` | `tasks/ad_recon.py` |

All 19 also listed in `TASK_TYPES` in `msp-ui/src/pages/Devices.jsx` with sensible default payloads.

---

## Phase 2 — Live Bandwidth Streaming (✅ Complete)

**Architecture:** Same WebSocket bridge pattern as terminal — rides the existing device channel, no new Pi connection needed.

```
Browser ──WS──▶ /v1/devices/{id}/bandwidth?token=&interface=&mode=&duration=
                        │ bandwidth_open
Server ──────▶ existing device WebSocket channel
                        │
Pi agent  ──▶ core/bandwidth.py ──▶ nethogs -t (process mode)
                                  OR iftop -t  (IP mode)
                        │ bandwidth_frame every ~1s
                        └──────────────────────────────────▶ Browser
```

### Agent additions
- `core/bandwidth.py` — `_BandwidthSession`: spawns nethogs (process mode) or iftop (IP mode), parses stdout, emits `bandwidth_frame` messages. Falls back nethogs → iftop if not installed. 1-hour hard cap.
- `core/connection.py` — `_receive_loop()`: routes `bandwidth_open`/`bandwidth_close` to `handle_bandwidth_message()`
- `install.sh` — adds `nethogs` and `iftop` to apt install block

### Server additions
- `app/api/v1/bandwidth.py` — WebSocket endpoint `/v1/devices/{device_id}/bandwidth`; authenticates operator JWT, checks device active, sends `bandwidth_open` to Pi, bridges frames to browser
- `app/api/v1/device_channel.py` — `bandwidth_frame`/`bandwidth_closed` message types routed to `route_bandwidth_message()`
- `app/main.py` — bandwidth router registered

### UI
- `msp-ui/public/bandwidth.html` — standalone popup (like terminal.html): live table, dual bar charts (↑/↓), 40-point sparklines per process/IP, column sort, mode/interface switcher, summary bar (total sent/recv/procs)
- `pages/DeviceDetail.jsx` — "📡 Live Bandwidth" button (active devices only), opens popup

### Protocol (server↔browser)
- Server→Browser: `{type:"frame", rows:[...], ts:<epoch>}` | `{type:"closed", reason}` | `{type:"error", message}`
- Browser→Server: `{type:"close"}`

### Protocol (server↔agent)
- Server→Agent: `{type:"bandwidth_open", session_id, interface, mode, duration}` | `{type:"bandwidth_close", session_id}`
- Agent→Server: `{type:"bandwidth_frame", session_id, rows:[...], ts}` | `{type:"bandwidth_closed", session_id, reason}`

### Row formats
- Process mode: `{pid, name, sent_kbps, recv_kbps}`
- IP mode: `{ip, rank, sent_kbps, recv_kbps}`

---

## Phase 3 — Remote Terminal Access (✅ Complete)

**Architecture:** Pure WebSocket PTY bridge over existing device channel — no SSH relay needed.

### Agent additions
- `core/terminal.py` — `_TerminalSession`: forks `/bin/bash` in PTY (`pty.fork()`), handles winsize via `TIOCSWINSZ`, streams stdout as base64 `terminal_output`, handles `terminal_open/input/resize/close`; `_sessions` dict tracks concurrent sessions by `session_id`
- `core/connection.py` — routes terminal messages to `handle_terminal_message()`

### Server additions
- `app/api/v1/terminal.py` — WebSocket `/v1/devices/{device_id}/terminal?token=...`; authenticates operator JWT, checks device active, generates `session_id` UUID, sends `terminal_open` to Pi, bridges browser↔Pi
- `app/api/v1/device_channel.py` — `terminal_output` routed to `route_terminal_output()`
- `app/main.py` — terminal router registered

### UI
- `msp-ui/public/terminal.html` — xterm.js **bundled inline** (no CDN). GitHub dark theme, FitAddon resize, base64 encode/decode, status indicator, reconnect button
- `pages/DeviceDetail.jsx` — "⌨ Terminal" button (active devices only), opens popup

### Protocol (server↔browser)
- Server→Browser: `{type:"output",data:"<base64>"}` | `{type:"closed"}` | `{type:"error",message}`
- Browser→Server: `{type:"input",data:"<base64>"}` | `{type:"resize",cols,rows}` | `{type:"close"}`

### Protocol (server↔agent)
- Server→Agent: `terminal_open/input/resize/close` with `session_id`
- Agent→Server: `terminal_output` with `session_id`, `data` (base64), `done` (bool)

---

## Phase 4 — Uptime Monitoring (✅ Complete)

- `models.py`: `MonitorTarget`, `UptimeCheck`
- `app/api/v1/monitoring.py`: CRUD `/v1/monitoring/targets`, GET `/uptime`, per-device uptime + RTT series
- `app/workers/main.py`: `wan_uptime_monitor()` pings `device.last_ip` every 60s, writes `UptimeCheck` with `source="wan"`
- Agent: `core/monitor.py` — background task pings `monitor_targets`, sends `uptime_ping` telemetry; server writes `UptimeCheck` with `source="lan"`
- UI: `pages/Monitoring.jsx` — uptime dashboard, RTT sparklines, Add/Delete Target modal
- `lib/api.js`: `getUptimeSummary`, `getDeviceUptime`, `getDeviceRtt`, `getMonitorTargets`, `createMonitorTarget`, `deleteMonitorTarget`

---

## Phase 5 — SNMP UI (⏳ Pending)

**What exists:**
- `tasks/snmp_query.py` — full SNMP walk/get with community string, returns structured OID data
- `run_snmp_query` in TASK_TYPES in Devices.jsx with default payload `{target, community:"public", oids:[]}`
- Task results viewable via generic task result modal in Devices.jsx / Tasks.jsx

**What's missing:**
- Dedicated SNMP page or device sub-page showing OID tree in a readable format (device name, interfaces, uptime, traffic counters, etc.)
- Quick-launch SNMP query buttons (common OIDs: sysDescr, ifTable, etc.)
- Historical SNMP polling / trending

---

## Phase 6 — Security/Vuln Scanning (✅ Complete)

- `models.py`: `ScanFinding` (severity enum: critical/high/medium/low/info, CVE, acknowledged, notes)
- `app/api/v1/security.py`: POST dispatch vuln/audit scans, GET/acknowledge/delete findings; `save_scan_findings()` auto-called from `device_channel.py` on task completion
- UI: `pages/Findings.jsx` — severity stat cards, New Scan modal, findings table with filters, slide-out detail drawer (raw output, CVE ID, acknowledge, notes)
- `pages/DeviceDetail.jsx` — "Findings" button

---

## Phase 7 — UI Additions (✅ Complete)

### Tasks page (new, `pages/Tasks.jsx`)
- Replaced stub in `OtherPages.jsx`
- Filter bar: status, task type, device
- Quick stat cards: completed/failed/running/queued
- Result viewer modal (JSON output + error display)
- Links to device detail

### Dashboard (rewritten, `pages/Dashboard.jsx`)
- 4 stat cards: active devices, offline, open findings (critical callout), running tasks
- Device table with WAN + LAN uptime % columns
- Recent open findings panel with severity badges
- Recent tasks panel
- Audit log panel

### Server additions
- `GET /v1/tasks` — global task list, filterable by `device_id`, `status`, `task_type`
- `_device_dict` now returns: `last_ip`, `msp_id`, `revoke_reason`, `created_at`
- `_task_dict` now returns: `device_id`, `dispatched_at`, `timeout_seconds`

### api.js additions
- `api.getAllTasks(params)` — calls `GET /v1/tasks`
- `api.getDeviceRtt(id, target, hours)` — calls RTT endpoint

---

## Phase 8 — AD Recon (✅ Complete)

- `models.py`: `ADReport` (denormalised JSON blob, no credentials stored)
- `app/api/v1/ad_recon.py`: POST discover/recon tasks, GET reports list/detail; `save_ad_report()` auto-called from `device_channel.py` on `run_ad_recon` completion
- UI: `pages/ADReport.jsx` — two-stage flow: Discover (finds DCs) → credentials form → Recon; tabbed results: Findings/Users/Groups/Kerberos/Password Policy/Shares; historical reports sidebar
- `pages/DeviceDetail.jsx` — "AD Report" button

---

## User Management (✅ Complete)

- `app/api/v1/admin.py`: `GET /v1/operators`, `PATCH /v1/operators/{id}`
- UI: `pages/Users.jsx` — Add/Edit modal, role picker (msp_admin/msp_operator/customer_viewer), activate/deactivate, cannot deactivate self, MSP admins cannot create super admins

---

## Server Models Summary (`app/models/models.py`)

| Model | Key fields |
|-------|-----------|
| `MSPOrganization` | id, name, slug, is_active |
| `CustomerOrganization` | id, msp_id, name, slug |
| `Site` | id, customer_id, msp_id, name |
| `Device` | id, site_id, customer_id, msp_id, name, status, role, last_ip, hardware_id, current_version |
| `Operator` | id, msp_id, email, password_hash, role, is_active |
| `Task` | id, device_id, msp_id, task_type, status, payload, result, error, queued_at, dispatched_at, completed_at |
| `Telemetry` | id, device_id, msp_id, telemetry_type, data |
| `MonitorTarget` | id, device_id, msp_id, label, host, interval_seconds, enabled |
| `UptimeCheck` | id, device_id, msp_id, target, source (lan/wan), success, rtt_ms, checked_at |
| `ScanFinding` | id, device_id, task_id, severity, title, description, cve_id, acknowledged, notes |
| `ADReport` | id, device_id, task_id, domain, dc_ip, functional_level, report_data (JSONB), total_users, domain_admins, kerberoastable, asrep_roastable, findings_critical/high/medium, computer_count, unconstrained_delegation, laps_deployed, laps_coverage_pct, adminsdholder_count, protected_users_count, fine_grained_policies, service_accounts |
| `ClientRelease` | id, msp_id, version, artifact_path, is_active |
| `DeviceUpdateJob` | id, device_id, release_id, status |
| `AuditLog` | id, msp_id, action, operator_id, device_id, detail, ip_address |

---

## Server Endpoints Summary

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/auth/login` | Operator login |
| GET | `/v1/devices` | List devices (MSP-scoped) |
| POST | `/v1/devices` | Create device (returns enrollment_secret) |
| POST | `/v1/devices/{id}/revoke` | Revoke device |
| POST | `/v1/devices/{id}/reset` | Re-enroll device |
| DELETE | `/v1/devices/{id}` | Delete device |
| POST | `/v1/devices/{id}/tasks` | Issue task |
| GET | `/v1/devices/{id}/tasks` | List device tasks |
| GET | `/v1/tasks` | List all tasks (MSP-scoped, filterable) |
| WS | `/v1/devices/channel` | Device WebSocket channel |
| WS | `/v1/devices/{id}/terminal` | Terminal bridge |
| WS | `/v1/devices/{id}/bandwidth` | Live bandwidth bridge |
| GET | `/v1/monitoring/targets` | List monitor targets |
| POST | `/v1/monitoring/targets` | Create monitor target |
| DELETE | `/v1/monitoring/targets/{id}` | Delete monitor target |
| GET | `/v1/monitoring/uptime` | Uptime summary |
| GET | `/v1/monitoring/devices/{id}/uptime` | Per-device uptime |
| GET | `/v1/monitoring/devices/{id}/rtt` | RTT time series |
| GET | `/v1/findings` | List findings (filterable) |
| GET | `/v1/devices/{id}/findings` | Device findings |
| POST | `/v1/findings/{id}/acknowledge` | Acknowledge finding |
| DELETE | `/v1/findings/{id}` | Delete finding |
| POST | `/v1/devices/{id}/scan/vuln` | Dispatch vuln scan |
| POST | `/v1/devices/{id}/scan/audit` | Dispatch security audit |
| POST | `/v1/devices/{id}/ad/discover` | Dispatch AD discover |
| POST | `/v1/devices/{id}/ad/recon` | Dispatch AD recon |
| GET | `/v1/devices/{id}/ad/reports` | List AD reports |
| GET | `/v1/devices/{id}/ad/reports/{rid}` | Get AD report |
| GET | `/v1/customers` | List customers |
| POST | `/v1/customers` | Create customer |
| GET | `/v1/sites` | List sites |
| POST | `/v1/sites` | Create site |
| GET | `/v1/operators` | List operators |
| POST | `/v1/operators` | Create operator |
| PATCH | `/v1/operators/{id}` | Update operator |
| DELETE | `/v1/operators/{id}` | Revoke operator |
| GET | `/v1/msps` | List MSPs (super_admin only) |
| POST | `/v1/msps` | Create MSP (super_admin only) |
| GET | `/v1/releases` | List releases |
| POST | `/v1/releases` | Upload release artifact |
| POST | `/v1/releases/{id}/rollout` | Trigger rollout |
| POST | `/v1/releases/{id}/revoke` | Revoke release |
| GET | `/v1/audit` | Audit log |
| GET | `/health` | Health check |
| GET | `/metrics` | Connected device count |

---

## Bug Fixes Applied

- `require_role` hierarchy: `SUPER_ADMIN` always passes; `MSP_ADMIN` passes when `MSP_OPERATOR` required
- Duplicate `send_to_device` removed from `connection_manager.py`
- Monitoring devices dropdown: devices load split from uptime load
- Users page 404: fixed to call `/v1/operators`
- Terminal `Terminal is not defined` error: fixed by bundling xterm.js inline
- `_device_dict` missing `last_ip` — added (needed by WAN uptime monitor and DeviceDetail)
- `_task_dict` missing `device_id` — added (needed by Tasks page)
- Dashboard stat cards using wrong `acknowledged_at` field — fixed to `acknowledged` (bool)

---

## What's Still Pending / Next Steps

### High priority (identified gaps)
1. **agent/requirements.txt missing** — no pip dependency manifest exists. Fresh Pi installs will hit import errors. Needs: `websockets`, `aiohttp`, `impacket`, and all task dependencies listed.
2. **No system package manifest** — `nmap`, `ldapsearch`, `rpcclient`, `smbclient`, `tshark`, `iperf3` are required by various tasks but not documented or verified by `install.sh`. Tasks silently return empty results if a binary is missing.
3. **HTTP Monitor has no dedicated UI page** — `run_http_monitor` is fully implemented in the agent and registered as a task, but results only appear as raw JSON in the Tasks table. Needs its own page with uptime history, response time graphs, and status code tracking.
4. **Reports page only covers 9 of 29 task types** — `ssl_check`, `security_audit`, `vuln_scan`, `ad_recon`, `snmp_query`, `dns_health`, `packet_capture` etc. produce results only accessible via DeviceDetail → Tasks. No cross-device report aggregation.
5. **No customer/site-scoped filtering anywhere** — Devices, Tasks, Findings, Dashboard all show MSP-wide data. With 20+ customers this becomes unworkable.
6. **No alerting or notifications** — monitoring detects offline devices but nothing fires. No email, webhook, or Slack integration.
7. **No PDF/export for reports** — no way to produce a client-deliverable from AD reports, findings, or network scans.
8. **Findings have no remediation workflow** — only acknowledge-or-delete. No assigned-to, in-progress, resolved states, or severity override.

### Lower priority / roadmap
- **Token revocation** — operator JWTs have no revocation; a Redis blocklist would allow instant invalidation
- **Account lockout** — complement to rate limiting after N failed logins
- **Audit log for failed logins**
- **mTLS for device channel** — certificate pinning on top of device JWT
- **Shodan public exposure check** (free API)
- **CVE correlation against NVD API**
- **Customer portal** — read-only view scoped to a single customer
- **Wireless security testing** — deauth detection, evil twin detection, WEP flag
- **Network config management** — RANCID/Oxidized-style config backup for switches/routers
---

## Security Hardening (Applied 2026-03-07)

All findings below were identified in audit and patched in `msp-security-hardening.zip`.

### 🔴 Critical — Fixed
| # | Vulnerability | Fix |
|---|---------------|-----|
| 1 | **AD credentials stored in DB** — `task.payload` included plaintext password persisted at `db.commit()` | `ad_recon.py`: `stored_payload` excludes password; `device_payload` (with password) sent to Pi in-memory only, then immediately cleared with `.pop()`. Password never written to DB. |
| 2 | **SNMP community string stored in task result** — written to DB as part of result JSON | `snmp_query.py`: community string removed from result dict before returning |
| 3 | **Bootstrap endpoint permanently live** — returned `409` when already bootstrapped, confirming platform existence | `admin.py`: now returns generic `404` after bootstrap; reveals nothing to attacker |
| 4 | **`/metrics` unauthenticated** — exposed connected device count to anyone | `main.py`: metrics now require valid operator Bearer token |
| 5 | **`/openapi.json` served in production** — leaked full API surface even with `/docs` disabled | `main.py`: `openapi_url=None` in production |

### 🟠 High — Fixed
| # | Vulnerability | Fix |
|---|---------------|-----|
| 6 | **No login rate limiting** — unlimited brute-force attempts | `management.py`: `@limiter.limit("10/minute")` on `/auth/login`; `slowapi` added to `requirements.txt` |
| 7 | **No password complexity** — single-char passwords accepted | `admin.py`: `_validate_password()` enforces 12+ chars, upper, lower, digit, special char on bootstrap + create_operator |
| 8 | **CORS `allow_origins=*`** | `main.py`: `allow_methods` restricted to explicit verbs; `allow_headers` restricted to `Authorization, Content-Type, X-Requested-With`. Origins still env-configurable but wildcard is default-safe for API. |
| 9 | **No HTTP security headers** | `main.py` middleware + `nginx.conf`: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, `HSTS`, `CSP`, `server_tokens off` |
| 10 | **Timing-based user enumeration on login** — bcrypt only ran when user found | `management.py`: always runs `verify_password()` against dummy hash when user not found, so response time is consistent |

### 🟡 Medium — Fixed
| # | Vulnerability | Fix |
|---|---------------|-----|
| 11 | **Operator JWT passed as URL query param for WebSocket** — logged in nginx access logs, server logs, browser history | New `POST /v1/ws-ticket` endpoint issues a 30-second single-use random ticket. `terminal.py`, `bandwidth.py` accept `?ticket=` (preferred) or `?token=` (fallback). `DeviceDetail.jsx` and both HTML popups now fetch a ticket first. |

### Remaining hardening recommendations (future work)
- **Token revocation** — operator JWTs have no revocation mechanism; a Redis-backed blocklist would allow instant invalidation on logout/deactivation
- **Account lockout** — after N failed logins, temporarily lock the account (complement to rate limiting)
- **Audit log for failed logins** — currently only successful logins are audited
- **mTLS for device channel** — device JWT is strong but certificate pinning would prevent token theft replay
- **Dependency scanning** — integrate `pip-audit` or Dependabot into CI
- **Secrets rotation** — `SECRET_KEY` and `DEVICE_TOKEN_SECRET` should be rotated periodically; add key versioning support
