"""
Task: run_default_creds
Payload:
  targets: list of IPs or hostnames
  checks: list of device types to check (default: all)
    - "http_basic"    — common HTTP basic auth devices (routers, cameras, NAS)
    - "ubiquiti"      — Ubiquiti UniFi / AirOS (ubnt/ubnt, port 443/80)
    - "hikvision"     — Hikvision cameras (admin/12345, port 80/443/8080)
    - "dahua"         — Dahua cameras (admin/admin, port 80)
    - "ipmi"          — IPMI/iDRAC/iLO (port 623 UDP detection)
    - "cisco"         — Cisco IOS HTTP interface (cisco/cisco, port 80)
    - "mikrotik"      — Mikrotik Winbox/HTTP (admin/blank, port 80)
    - "printer"       — HP/Canon/Ricoh printer web UI (port 80/443)
  timeout: seconds per check (default: 5)

Read-only — only attempts authentication, never modifies anything.
"""

import asyncio
import logging
import re
import socket
import ssl
import urllib.error
import urllib.request
import base64

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')


# ── Device profiles ───────────────────────────────────────────────────────────

DEVICE_PROFILES = {
    "ubiquiti": {
        "name": "Ubiquiti UniFi / AirOS",
        "checks": [
            {"port": 443, "https": True,  "path": "/",
             "creds": [("ubnt", "ubnt"), ("admin", "admin"), ("admin", "ubnt")]},
            {"port": 80,  "https": False, "path": "/",
             "creds": [("ubnt", "ubnt"), ("admin", "admin")]},
        ],
    },
    "hikvision": {
        "name": "Hikvision IP Camera",
        "checks": [
            {"port": 80,   "https": False, "path": "/ISAPI/Security/userCheck",
             "creds": [("admin", "12345"), ("admin", "admin"), ("admin", "")]},
            {"port": 443,  "https": True,  "path": "/ISAPI/Security/userCheck",
             "creds": [("admin", "12345"), ("admin", "admin")]},
            {"port": 8080, "https": False, "path": "/ISAPI/Security/userCheck",
             "creds": [("admin", "12345")]},
        ],
    },
    "dahua": {
        "name": "Dahua IP Camera",
        "checks": [
            {"port": 80, "https": False, "path": "/cgi-bin/global.login",
             "creds": [("admin", "admin"), ("admin", ""), ("admin", "admin123")]},
        ],
    },
    "cisco": {
        "name": "Cisco IOS HTTP",
        "checks": [
            {"port": 80, "https": False, "path": "/exec/show/version",
             "creds": [("cisco", "cisco"), ("admin", "admin"), ("admin", "cisco")]},
        ],
    },
    "mikrotik": {
        "name": "Mikrotik RouterOS",
        "checks": [
            {"port": 80,  "https": False, "path": "/",
             "creds": [("admin", ""), ("admin", "admin")]},
            {"port": 443, "https": True,  "path": "/",
             "creds": [("admin", ""), ("admin", "admin")]},
        ],
    },
    "printer": {
        "name": "Network Printer",
        "checks": [
            {"port": 80,  "https": False, "path": "/",
             "creds": [("admin", "admin"), ("admin", ""), ("admin", "1234"),
                       ("", ""), ("guest", "guest")]},
            {"port": 443, "https": True,  "path": "/",
             "creds": [("admin", "admin"), ("admin", "")]},
        ],
    },
    "http_basic": {
        "name": "HTTP Basic Auth",
        "checks": [
            {"port": 80,  "https": False, "path": "/",
             "creds": [("admin", "admin"), ("admin", "password"), ("admin", ""),
                       ("admin", "1234"), ("root", "root"), ("user", "user"),
                       ("admin", "admin123"), ("administrator", "administrator")]},
            {"port": 443, "https": True,  "path": "/",
             "creds": [("admin", "admin"), ("admin", "password"), ("admin", "")]},
            {"port": 8080, "https": False, "path": "/",
             "creds": [("admin", "admin"), ("admin", "")]},
        ],
    },
    "ipmi": {
        "name": "IPMI / BMC",
        "checks": [],  # Detection only via UDP port probe
        "_detection_only": True,
        "_ports": [623],
        "_protocol": "udp",
    },
}

ALL_CHECKS = list(DEVICE_PROFILES.keys())


async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    checks      = payload.get("checks", ALL_CHECKS)
    timeout     = float(payload.get("timeout", 5))

    targets = [
        t.strip() for t in raw_targets
        if SAFE_HOST_RE.match(str(t).strip())
    ]
    if not targets:
        raise ValueError("No valid targets provided")

    # Validate requested check types
    checks = [c for c in checks if c in DEVICE_PROFILES]
    if not checks:
        checks = ALL_CHECKS

    all_results  = []
    all_findings = []

    host_tasks = [
        _check_host(host, checks, timeout)
        for host in targets[:30]
    ]
    host_results = await asyncio.gather(*host_tasks, return_exceptions=False)

    for r in host_results:
        all_results.append(r)
        all_findings.extend(r.get("findings", []))

    return {
        "targets_checked": len(all_results),
        "findings_count":  len(all_findings),
        "findings":        all_findings,
        "hosts":           all_results,
    }


async def _check_host(host: str, checks: list, timeout: float) -> dict:
    result   = {"host": host, "findings": [], "checked": []}
    loop     = asyncio.get_running_loop()

    for check_type in checks:
        profile = DEVICE_PROFILES[check_type]

        # Detection-only (IPMI UDP)
        if profile.get("_detection_only"):
            for port in profile.get("_ports", []):
                proto = profile.get("_protocol", "tcp")
                open_ = await _probe_port(host, port, proto, timeout)
                result["checked"].append({
                    "type": check_type, "port": port, "reachable": open_
                })
                if open_:
                    result["findings"].append({
                        "host":     host,
                        "type":     check_type,
                        "device":   profile["name"],
                        "severity": "high",
                        "title":    f"{profile['name']} interface detected",
                        "detail":   f"UDP port {port} is open — IPMI/BMC detected. Verify default credentials are changed.",
                        "port":     port,
                    })
            continue

        # Credential checks
        for check in profile["checks"]:
            port  = check["port"]
            https = check["https"]
            path  = check["path"]
            creds = check["creds"]

            # Quick port check before trying creds
            port_open = await _probe_port(host, port, "tcp", timeout)
            if not port_open:
                continue

            result["checked"].append({"type": check_type, "port": port, "reachable": True})

            for username, password in creds:
                try:
                    success, status = await asyncio.wait_for(
                        loop.run_in_executor(
                            None, _try_http_auth,
                            host, port, https, path, username, password
                        ),
                        timeout=timeout + 2,
                    )
                except Exception:
                    continue

                if success:
                    cred_str = f"{username}/{password!r}" if password else f"{username}/(blank)"
                    result["findings"].append({
                        "host":      host,
                        "type":      check_type,
                        "device":    profile["name"],
                        "severity":  "critical",
                        "title":     f"Default credentials accepted: {profile['name']}",
                        "detail":    f"Port {port} — login succeeded with {cred_str}.",
                        "port":      port,
                        "username":  username,
                        # Never include password in result
                    })
                    break  # Found working creds for this port — stop trying

    return result


async def _probe_port(host: str, port: int, proto: str, timeout: float) -> bool:
    try:
        if proto == "udp":
            loop = asyncio.get_running_loop()
            return await asyncio.wait_for(
                loop.run_in_executor(None, _udp_probe, host, port),
                timeout=timeout,
            )
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        writer.close()
        return True
    except Exception:
        return False


def _udp_probe(host: str, port: int) -> bool:
    """Send a minimal packet and see if we get anything back (or no ICMP port unreachable)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2)
            s.sendto(b'\x00', (host, port))
            s.recvfrom(64)
            return True
    except socket.timeout:
        # No ICMP unreachable = port likely open
        return True
    except Exception:
        return False


def _try_http_auth(host: str, port: int, https: bool,
                   path: str, username: str, password: str) -> tuple[bool, int]:
    """
    Attempt HTTP Basic auth. Returns (success, status_code).
    'success' means we got a 200 (or non-401/403 response).
    """
    scheme = "https" if https else "http"
    url    = f"{scheme}://{host}:{port}{path}"
    creds  = base64.b64encode(f"{username}:{password}".encode()).decode()

    ctx = None
    if https:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode    = ssl.CERT_NONE

    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Basic {creds}",
            "User-Agent":    "MSP-Agent/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=5) as resp:
            return resp.status not in (401, 403), resp.status
    except urllib.error.HTTPError as e:
        return e.code not in (401, 403), e.code
    except Exception:
        return False, 0
