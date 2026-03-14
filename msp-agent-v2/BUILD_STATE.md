# MSP Agent — Build State

Last updated: 2026-03-09

> **Note to Claude:** Update this file whenever changes are made to the agent.
> Record every fix, improvement, or new feature under a new dated section.
> Keep the Phase Status table, File Inventory, and Known Issues sections current.
> This is the canonical source of truth for what has and hasn't been done to the agent.

---

## Infrastructure

- **Agent install path:** `/opt/msp-agent/`
- **Config path:** `/etc/msp-agent/config.json`
- **Log path:** `/var/log/msp-agent/agent.log`
- **Service:** `msp-agent.service` (systemd)
- **Server:** `https://tekn-api.synhow.com` / `wss://tekn-api.synhow.com`
- **Pi device_id:** `f7be66db-bc21-4fc4-ab51-d90d26daa042`
- **Pi hardware_id:** `93949c77e57eac2b`
- **Pi hostname:** `debby-unknown`
- **Do NOT modify** `display.py` or any display-related code

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Core agent + enrollment + 19 tasks | ✅ Complete |
| 2 | Live bandwidth streaming | ✅ Complete |
| 3 | Remote terminal (PTY bridge) | ✅ Complete |
| 4 | Background uptime monitoring | ✅ Complete |
| R1 | Requirements + install.sh hardening | ✅ Complete |
| R2 | Stability + security sweep (round 1) | ✅ Complete |
| R3 | Stability + security sweep (round 2) | ✅ Complete |
| R4–R8 | Platform generalisation, Pi detection, non-free repos, SNMP fix, AD recon expansion | ✅ Complete |
| R9 | DHCP fix + GPO SYSVOL detail parsing | ✅ Complete |

## Vuln Scan Overhaul (✅ 2026-03-09)

### `tasks/vuln_scan.py` — rewritten

**CVE/CVSS parsing**
- `vulners` script output now parsed with regex to extract individual CVE IDs and CVSS scores
- CVSS score mapped to severity: ≥9.0=critical, ≥7.0=high, ≥4.0=medium, ≥0.1=low
- Previously all vulners findings were `info` regardless of CVSS; CVE-2014-4078 (CVSS 5.1) is now correctly `medium`

**Title extraction**
- nmap VULNERABLE block parser (`_parse_vuln_block`) extracts the human-readable title from `VULNERABLE:\n  <title>` lines
- `_script_id_to_title()` lookup table maps 15+ common script IDs to descriptive names
- No more "Unknown finding" in the DB — every finding has a meaningful title

**Dedicated handlers for important script types**
- `_parse_ssl_cert()` — only produces a finding if cert is expired (high), expiring ≤30d (medium), or ≤60d (low). Valid certs are silently skipped.
- `_check_http_security_headers()` — blank output means ALL headers missing → medium finding with explicit list
- `_check_http_methods()` — TRACE enabled → medium (XST attack vector)
- `_check_smb_protocols()` — NT LM 0.12 (SMBv1) present → high, CVE-2017-0143, actionable remediation text
- `_check_smb_security_mode()` — guest/null session → medium
- `_check_dns_blacklist()` — SPAM/malware hits → medium

**Noise suppression**
- `NOISE_SCRIPTS` set: http-fetch, http-date, http-useragent-tester, ssl-date, clock-skew, smb2-time, fcrdns, port-states, nbstat, msrpc-enum, etc. — completely filtered
- `INFO_ONLY_SCRIPTS` set: http-title, rdp-enum-encryption, smb-os-discovery, smb2-capabilities, http-xssed, smb-enum-services — suppressed
- ERROR: prefix on script output → skipped
- Generic scripts that classify as `info` → not emitted to DB

**Deduplication**
- `_dedup_findings()` keeps highest-severity finding per `(script_id, port)` per host
- Prevents e.g. ssl-cert errors flooding findings for the same cert on different ports

**Port scope**
- New `top_ports` payload param (default: 100, max: 1000) — uses nmap `--top-ports N`
- `ports` param (explicit list) still supported and takes precedence over top_ports
- `--version-intensity` raised from 2 → 5 for better service/version detection
- OS detection result now included in host data

**Result shape additions**
- Each finding now includes `cvss` (float or None) and `title` (always populated)
- `host` objects now include `os` field from nmap OS detection

---

## Round 1 — Requirements & Install Hardening (✅ 2026-03-08)

### New: `requirements.txt`
- `websockets>=12.0` — required, core WebSocket channel
- `impacket>=0.12.0` — optional, AD Kerberos via `python3 -m impacket.examples.GetUserSPNs`
- `speedtest-cli>=2.1.3` — optional, falls back to HTTP download test

### Updated: `install.sh`
- Now installs Python deps via `pip3 install -r requirements.txt` instead of ad-hoc one-liners
- Added post-install binary verification block: checks all 22 system binaries (`nmap`, `tshark`, `ldapsearch`, `nethogs`, `iperf3`, etc.) and categorises as required vs optional
- Prints `✗ binary (pkg: package-name)` for each missing required tool so operator knows exactly what to fix
- Verifies `websockets` is importable before starting the service
- Success banner now reports whether all tools passed or lists warnings

---

## Round 2 — Stability & Security Sweep (✅ 2026-03-08)

### Bug fix: `core/terminal.py` (new file — was missing entirely)
- `connection.py` imported `from core.terminal import handle_terminal_message` since Phase 3 but the file never existed in the agent zip
- Any `terminal_open` message from the server caused `ModuleNotFoundError` and crashed the receive loop
- Full PTY bridge implemented: forks `/bin/bash`, streams stdout as base64, handles resize via `TIOCSWINSZ`, caps concurrent sessions at 4

### Stability: `core/connection.py`
- Added `MAX_CONCURRENT_TASKS = 3` semaphore — tasks now queue instead of all running simultaneously (Pi Zero W protection)
- Added `disk` and `active_tasks` fields to heartbeat payload (was only sending memory + temp)

### Observability: `core/dispatcher.py`
- Log messages switched to structured `key=value` format for easier `grep`/`awk` in `journalctl`

### Aesthetics: `core/logger.py`
- Startup banner now printed on every agent start — visible in journal and log file:
  ```
  ────────────────────────────────────────────────────
    MSP Agent  v1.0.0
    Device : f7be66db-...
    Host   : debby-unknown
    Server : wss://tekn-api.synhow.com
    Log    : INFO
  ────────────────────────────────────────────────────
  ```

### Functionality: `core/hardware.py`
- Added `get_cpu_usage_pct(interval)` — samples `/proc/stat`, no external deps
- Added `import time` (needed by new function)

### Stability: `msp-agent.service`
- `/opt/msp-agent` added to `ReadWritePaths` (was missing — updater backup step silently failed)
- `OOMScoreAdjust=-100` added (Pi OOM killer now deprioritises killing the agent)

### Minor: `agent.py`
- Missing `config.json` now prints a clean error to stderr and exits with code 1 instead of an unformatted traceback

---

## Round 8 — Expanded AD Recon (✅ 2026-03-08)

Major expansion of `tasks/ad_recon.py`. File grew from 816 to 1,312 lines. All new collectors run in the existing `asyncio.gather` parallel block — no increase in wall-clock time for environments where the DC responds quickly.

### New collectors

| Collector | What it pulls |
|-----------|---------------|
| `_get_computers()` | All non-DC computer objects: name, OS, version, enabled state, stale flag, last logon, managedBy, location, LAPS enrollment per machine |
| `_get_fine_grained_policies()` | Password Settings Objects (PSOs) — min length, max age, lockout, complexity, reversible encryption, precedence, and which users/groups each applies to |
| `_get_delegations()` | Three delegation types: unconstrained (critical — non-DC accounts), constrained (with/without protocol transition), resource-based constrained (RBCD) |
| `_get_adminsdholder()` | All users with `adminCount=1` — AdminSDHolder-protected accounts, including disabled ones that are still being managed by SDProp |
| `_get_protected_users()` | Members of the Protected Users security group |
| `_get_service_accounts()` | MSA, gMSA, and traditional user-with-SPN accounts enumerated separately |
| `_get_laps_status()` | Schema presence check + enrolled/total computer count + coverage % |

### Expanded collectors

**`_get_shares()`** — now fetches share-level ACLs via `rpcclient getshareinfo` for each Disk share. Returns `permissions[]` with principal, access mask, access type, and human-readable rights (Full Control / Change / Read).

**`_get_gpos()`** — GPOs now include:
- `computer_settings` and `user_settings`: lists of human-readable capability names decoded from `gPCMachineExtensionNames` / `gPCUserExtensionNames` CSE GUIDs (16 known CSEs mapped, no SYSVOL access needed)
- `computer_version` and `user_version`: split from `versionNumber` high/low 16-bit halves
- `created` date (was missing before)

**`_get_groups()`** — now does recursive nested group resolution up to depth 3. Each privileged group entry now returns `members` (direct), `nested_members` (from nested groups), and `total_effective` (deduplicated count).

**`_get_users()`** — added `logon_script`, `home_directory`, `profile_path`, `upn`, `title`, `department`, `pwd_last_set`, `sensitive_no_deleg` flag, `trusted_for_deleg` flag.

### New findings

- Unconstrained delegation on non-DC accounts → **critical**
- Constrained delegation with protocol transition → **high**
- LAPS not deployed → **high**; LAPS coverage < 80% → **medium**
- Disabled AdminSDHolder accounts still managed by SDProp → **medium**
- Domain Admins not in Protected Users group → **medium**
- PSO with reversible encryption → **high**; PSO with weak min length → **medium**
- Traditional service accounts that are Kerberoastable (suggest gMSA migration) → **high**
- Unlinked GPOs (no effect, cleanup candidate) → **info**
- User accounts with `TRUSTED_FOR_DELEGATION` UAC flag → **high**
- Stale computer accounts → **low**

### Summary fields added
`unconstrained_delegation`, `constrained_delegation`, `adminsdholder_count`, `protected_users_count`, `laps_deployed`, `laps_coverage_pct`, `computer_count`, `fine_grained_policies`, `service_accounts`

---



### New: `install.sh` — Pi detection + hardware-adaptive configuration
Added a hardware detection block that runs immediately after the installer banner, before any packages are touched. It sets three variables used throughout the rest of the script:

- `IS_PI` (true/false) — detected via `/proc/device-tree/model` (primary), `/sys/firmware/devicetree/base/model` (fallback), or BCM283x/BCM271x in `/proc/cpuinfo` Hardware field (last resort)
- `PI_MODEL` — full model string e.g. `"Raspberry Pi Zero 2 W Rev 1.0"`, empty on non-Pi
- `SERVICE_MEMORY_MAX` — computed from `/proc/meminfo` MemTotal:
  - Pi: half of total RAM, floored at 128M, capped at 512M
  - Non-Pi with ≤2GB RAM (cheap VPS): half of total RAM
  - Non-Pi with >2GB RAM: no limit (MemoryMax line commented out)

The service file's `MemoryMax` line is patched in-place after copying to `/etc/systemd/system/` using `sed`, so every install gets a value tuned to the actual hardware rather than a hardcoded guess.

### Updated: `core/config.py`
Added `pi_model: str = ""` field to `AgentConfig`. Empty string on non-Pi. Populated from `config.json` on load — safe for existing configs (defaults to `""`).

### Updated: `core/connection.py`
Added `"pi_model"` to the heartbeat payload (sent as `null` on non-Pi). Lets the server display the model in the device inventory without needing a separate API call.

---



Agent is no longer Pi-specific. Tested assumptions removed across all files:

| File | Change |
|------|--------|
| `install.sh` | Header updated to list all supported platforms/arches. Hardware ID fallback now enumerates all non-loopback interfaces via `/sys/class/net/` and picks the first active one — no longer hardcodes `wlan0` |
| `core/hardware.py` | Module docstring generalised. `get_cpu_serial()` docstring clarified (Pi serial is best-effort; hash fallback works everywhere). `_get_mac_address()` rewrites to enumerate all interfaces, preferring `up` state — no longer hardcodes `wlan0`/`eth0`. `get_arch()` fallback changed from `"armv6l"` → `"unknown"` |
| `msp-agent.service` | `MemoryMax` raised from `128M` → `256M` (128M was Pi Zero W's total RAM — too low for an x86 server running nmap/tshark tasks). Comment updated to suggest tuning for hardware |
| `agent.py` | Docstring updated — lists supported platforms |
| `tasks/sysinfo.py` | `_get_wifi_info()` no longer hardcodes `wlan0`. New `_find_wireless_interface()` helper inspects `/sys/class/net/<iface>/wireless` to auto-detect the wireless interface on any platform. Also now includes `"interface"` field in the returned dict |
| `README.md` | Title, intro, supported platforms table, and install instructions generalised. Fixed stale backup path (`/tmp/` → `/opt/msp-agent/`) in self-update flow |

---



### New: `install.sh` — auto-enable contrib/non-free apt repos
Added a repo-check block that runs before any `apt-get install`. Handles all three sources formats found on Pi OS and Debian:
- Classic `/etc/apt/sources.list` (Bullseye and older)
- Drop-in `/etc/apt/sources.list.d/*.list` files (Pi OS often uses these)
- DEB822 `/etc/apt/sources.list.d/*.sources` files (Bookworm+)

Detects the OS codename from `/etc/os-release` and adds `contrib non-free` (plus `non-free-firmware` on Bookworm and newer, where firmware was split into its own component). Skips silently if non-free is already enabled. Runs `apt-get update` only if changes were made. This allows `snmp-mibs-downloader` and other non-free packages to install correctly.

---



### Bug fix: SNMP tools silently not installed (`install.sh`)
`snmp-mibs-downloader` is not in the standard Raspberry Pi OS repos (requires `non-free` component). It was being installed in the same `apt-get` block as `snmp` — when `snmp-mibs-downloader` failed, the `||` short-circuited and `snmp` was never installed either, leaving `snmpwalk` and `snmpget` missing. Fixed by splitting into two separate `apt-get` calls so `snmp` always installs and `snmp-mibs-downloader` fails silently on its own.

### Removed: `enum4linux` (`install.sh`)
Removed the `enum4linux` apt install attempt and its entry in the post-install verification checklist. Not available in standard repos, not worth the noisy warning.

---



### Bug fix: Subprocess hang vulnerability — 5 tasks
Four tasks had **no timeout on `proc.communicate()`** — a hung subprocess would hold a task semaphore slot forever:

| File | Fix |
|------|-----|
| `tasks/traceroute.py` | `wait_for(communicate(), timeout=max_hops * 3 + 15)` |
| `tasks/mtr_report.py` | `wait_for(communicate(), timeout=count * 3 + 20)` on both JSON + plaintext runs |
| `tasks/arp_scan.py` | `wait_for(communicate(), timeout=60)` |
| `tasks/wireless_survey.py` | `wait_for` on all three backends: `iw` (30s), `iwlist` (30s), `wpa_cli` (15s) |
| `tasks/nmap_scan.py` | `wait_for(communicate(), timeout=30 * len(targets) + 30)` |

All kill the subprocess on timeout instead of leaving zombies.

### Bug fix: `asyncio.Lock()` at module import time (`core/monitor.py`)
- `_lock = asyncio.Lock()` ran before the event loop existed — raises `DeprecationWarning` in Python 3.10+ and errors in some 3.12 configurations
- Replaced with lazy `_get_lock()` factory, called on first use inside the running loop

### Bug fix: Updater cross-device `os.replace()` failure (`core/updater.py`)
- `PrivateTmp=yes` in the service file makes `/tmp` a private tmpfs mount
- `os.replace("/tmp/msp-agent.new", "/usr/local/bin/msp-agent")` raises `EXDEV` (invalid cross-device link) — every OTA update would silently fail at install and roll back
- Fixed: `AGENT_DOWNLOAD_PATH` changed to `/opt/msp-agent/msp-agent.new` (same filesystem as the install target, already in `ReadWritePaths`)

### Bug fix: `monitor_config` messages silently ignored (`core/dispatcher.py`)
- `monitor.py` has `update_monitor_config()` and its docstring says the server pushes `monitor_config` to update targets — but the dispatcher never handled that message type
- Messages fell through to `logger.debug("Unhandled message type")` and were dropped — LAN monitoring targets could never change after startup
- Added `elif msg_type == "monitor_config"` handler in dispatcher

---

## File Inventory

### Core (`core/`)

| File | Purpose | Notes |
|------|---------|-------|
| `agent.py` | Entry point — starts event loop, registers signal handlers | |
| `core/config.py` | `AgentConfig` dataclass, `load_config()`, `save_config()` | Atomic write via `.tmp` + `os.replace` |
| `core/connection.py` | WebSocket connection manager — reconnect, heartbeat, send/receive loops | Task semaphore (max 3 concurrent) |
| `core/dispatcher.py` | Routes inbound messages to task handlers | Structured log format |
| `core/enrollment.py` | One-shot device enrollment + token refresh via HTTP | Uses stdlib `urllib` only |
| `core/hardware.py` | Pi hardware helpers: serial, arch, uptime, temp, memory, disk, CPU% | All `/proc`-based, no deps |
| `core/logger.py` | Logging setup — stdout + rotating file + startup banner | |
| `core/monitor.py` | Background LAN uptime monitor loop | Lazy `asyncio.Lock` |
| `core/terminal.py` | PTY bridge for remote terminal sessions | Max 4 concurrent sessions |
| `core/bandwidth.py` | Live bandwidth streaming via nethogs/iftop | |
| `core/updater.py` | OTA self-update with SHA256 verify + rollback | Download to `/opt/msp-agent/`, not `/tmp` |

### Tasks (`tasks/`)

| Task type | Module | Notes |
|-----------|--------|-------|
| `get_sysinfo` | `tasks/sysinfo.py` | |
| `run_speedtest` | `tasks/speedtest.py` | Falls back to HTTP if speedtest-cli missing |
| `run_ping_sweep` | `tasks/ping_sweep.py` | |
| `run_arp_scan` | `tasks/arp_scan.py` | Timeout fixed R3 |
| `run_nmap_scan` | `tasks/nmap_scan.py` | Timeout fixed R3 |
| `run_port_scan` | `tasks/port_scan.py` | |
| `run_netbios_scan` | `tasks/netbios_scan.py` | |
| `run_lldp_neighbors` | `tasks/lldp_neighbors.py` | |
| `run_wireless_survey` | `tasks/wireless_survey.py` | 3 backends; timeouts fixed R3 |
| `run_wol` | `tasks/wol.py` | |
| `run_dns_lookup` | `tasks/dns_lookup.py` | |
| `run_traceroute` | `tasks/traceroute.py` | Timeout fixed R3 |
| `run_mtr` | `tasks/mtr_report.py` | Timeout fixed R3 |
| `run_iperf` | `tasks/iperf_test.py` | |
| `run_banner_grab` | `tasks/banner_grab.py` | |
| `run_packet_capture` | `tasks/packet_capture.py` | Single pcap + post-process |
| `run_http_monitor` | `tasks/http_monitor.py` | SSL cert check included |
| `run_ntp_check` | `tasks/ntp_check.py` | |
| `run_snmp_query` | `tasks/snmp_query.py` | Community string scrubbed from result |
| `run_ssl_check` | `tasks/ssl_check.py` | |
| `run_dns_health` | `tasks/dns_health.py` | SPF/DMARC/DKIM checks |
| `run_vuln_scan` | `tasks/vuln_scan.py` | nmap XML parse, severity classification |
| `run_security_audit` | `tasks/security_audit.py` | asyncio.gather + Semaphore(10) |
| `run_default_creds` | `tasks/default_creds.py` | |
| `run_cleartext_services` | `tasks/cleartext_services.py` | |
| `run_smb_enum` | `tasks/smb_enum.py` | |
| `run_ad_discover` | `tasks/ad_discover.py` | nmblookup/smbclient, no enum4linux |
| `run_ad_recon` | `tasks/ad_recon.py` | 12 parallel LDAP collectors; creds scrubbed immediately |
| `run_email_breach` | `tasks/email_breach.py` | HIBP API; key never stored |

---

## Round 9 — DHCP Fix + GPO SYSVOL Detail Parsing (✅ 2026-03-09)

### Bug fix: `_get_dhcp_scopes()` — DN reconstruction failure
The original code reconstructed the DHCP server's LDAP DN from its `CN` attribute value (e.g. `CN=servername,CN=NetServices,...`). When AD stores the server's FQDN as the CN, the reconstructed path is wrong and the child scope query returns nothing. Fixed by using the actual `dn` value returned directly by ldapsearch instead of reconstructing it. Also fixed `dhcpRanges` handling (multi-valued attribute — one `startIP endIP` string per range) and now captures `dhcpComment` (human-readable scope name) and `dhcpSubnetMask`.

### New: `_fetch_gpo_settings()` + `_parse_gpttmpl_inf()`
After building the GPO list, the agent now downloads and parses `GptTmpl.inf` from each GPO's SYSVOL folder via `smbget`. This is the security template file — plain-text INI format, readable by any authenticated domain user.

Parsed sections:
- **System Access** — password/lockout policy values set by the GPO (overrides domain default for linked OUs)
- **Privilege Rights** — user rights assignments with SE constants translated to human names (SeDebugPrivilege, SeRemoteInteractiveLogonRight, etc.)
- **Event Audit** — legacy audit categories (Success/Failure/both/none)
- **Group Membership** — restricted groups enforced by the GPO
- **Registry Values** — key security options: LM compat level, SMB signing, anonymous access restrictions, RDP state

Results stored in `gpo["details"]` dict. GPOs without a `GptTmpl.inf` (registry-only/ADMX-based policies) return an empty dict — the UI handles this gracefully with no details block shown.

**Limitation:** ADMX/registry-based settings (the majority of modern GPOs) live in `Registry.pol` (binary PReg format) — not parsed yet. The `computer_settings`/`user_settings` CSE tags still correctly indicate which types of settings a GPO contains even when details are unavailable.

### New: `_base_dn_from_domain()` helper
Extracted repeated `",".join(f"DC={p}" for p in domain.split("."))` pattern into a named helper used by both DHCP and GPO code.

## Known Issues / Next Steps

- **Outbound queue unbounded** — `asyncio.Queue()` in `ConnectionManager` has no size cap. `send()` will buffer indefinitely during long disconnects. Needs a backpressure policy decision (drop newest / oldest / block) before fixing.
- **`get_cpu_usage_pct()` not yet in heartbeat** — implemented in `hardware.py` but not wired into the heartbeat payload in `connection.py`. Requires server-side schema update to store/display it.
- **`monitor_config` server-side push not yet implemented** — dispatcher now handles it correctly, but the server needs to push `monitor_config` when targets change (currently only sends on reconnect if at all).
- **No task cancellation** — once a task is dispatched there is no way for the server to cancel it mid-run. Would need a `task_cancel` message type and per-task `asyncio.Task` tracking in the dispatcher.
- **Credentials in ldapsearch/smbclient argv** — passwords passed via `-w password` / `-U user%pass` are visible in `ps aux` for the subprocess lifetime. Mitigation: use `LDAP_BIND_PW` env var or a credentials file written to a tmpfs and deleted after. Low risk on a locked-down Pi with no other users, but worth noting.
