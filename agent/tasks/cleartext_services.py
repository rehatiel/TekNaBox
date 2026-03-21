"""
Task: run_cleartext_services
Payload:
  targets: list of IPs/hostnames to check
  checks: list of service checks to run (default: all)
    - "telnet"       — Telnet open (port 23)
    - "ftp"          — FTP without TLS (PORT 21)
    - "smtp_plain"   — SMTP without STARTTLS (port 25, 587)
    - "http_basic"   — HTTP serving Basic-Auth header without TLS
    - "ldap_plain"   — LDAP without LDAPS / StartTLS (port 389)
    - "vnc"          — VNC open (port 5900)
    - "x11"          — X11 forwarding open (port 6000-6010)
    - "imap_plain"   — IMAP without STARTTLS (port 143)
    - "pop3_plain"   — POP3 without STARTTLS (port 110)
    - "snmp_v1v2"    — SNMPv1/v2 (plaintext, port 161)
  timeout: seconds per check (default: 4)
"""

import asyncio
import logging
import re
import socket

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')

ALL_CHECKS = [
    "telnet", "ftp", "smtp_plain", "http_basic",
    "ldap_plain", "vnc", "x11", "imap_plain", "pop3_plain", "snmp_v1v2",
]


async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    checks      = payload.get("checks", ALL_CHECKS)
    timeout     = float(payload.get("timeout", 4))

    targets = [
        t.strip() for t in raw_targets
        if SAFE_HOST_RE.match(str(t).strip())
    ]
    if not targets:
        raise ValueError("No valid targets provided")

    checks = [c for c in checks if c in ALL_CHECKS]

    all_findings = []
    host_results = await asyncio.gather(
        *[_check_host(host, checks, timeout) for host in targets[:50]],
        return_exceptions=False,
    )

    for r in host_results:
        all_findings.extend(r.get("findings", []))

    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    all_findings.sort(key=lambda f: sev_order.get(f.get("severity", "low"), 3))

    return {
        "targets_checked": len(host_results),
        "findings_count":  len(all_findings),
        "findings":        all_findings,
        "hosts":           host_results,
    }


async def _check_host(host: str, checks: list, timeout: float) -> dict:
    result   = {"host": host, "findings": []}
    subtasks = []

    if "telnet"     in checks: subtasks.append(_check_telnet(host, timeout))
    if "ftp"        in checks: subtasks.append(_check_ftp(host, timeout))
    if "smtp_plain" in checks: subtasks.append(_check_smtp(host, timeout))
    if "http_basic" in checks: subtasks.append(_check_http_basic(host, timeout))
    if "ldap_plain" in checks: subtasks.append(_check_ldap(host, timeout))
    if "vnc"        in checks: subtasks.append(_check_vnc(host, timeout))
    if "x11"        in checks: subtasks.append(_check_x11(host, timeout))
    if "imap_plain" in checks: subtasks.append(_check_imap(host, timeout))
    if "pop3_plain" in checks: subtasks.append(_check_pop3(host, timeout))
    if "snmp_v1v2"  in checks: subtasks.append(_check_snmp(host, timeout))

    findings_lists = await asyncio.gather(*subtasks, return_exceptions=True)
    for f in findings_lists:
        if isinstance(f, list):
            result["findings"].extend(f)

    return result


# ── Individual service checks ─────────────────────────────────────────────────

async def _banner(host: str, port: int, timeout: float,
                  send: bytes = None) -> str | None:
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        if send:
            w.write(send)
            await w.drain()
        data = await asyncio.wait_for(r.read(512), timeout=timeout)
        w.close()
        return data.decode("utf-8", errors="replace").strip()
    except Exception:
        return None


async def _port_open(host: str, port: int, timeout: float) -> bool:
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        w.close()
        return True
    except Exception:
        return False


async def _check_telnet(host: str, timeout: float) -> list:
    if not await _port_open(host, 23, timeout):
        return []
    banner = await _banner(host, 23, timeout) or ""
    return [{
        "host": host, "check": "telnet", "severity": "high",
        "title": "Telnet service open",
        "detail": f"Port 23 open. Telnet transmits credentials in cleartext. Banner: {banner[:100]}",
    }]


async def _check_ftp(host: str, timeout: float) -> list:
    banner = await _banner(host, 21, timeout)
    if not banner:
        return []
    # Check if TLS is supported
    tls_banner = await _banner(host, 21, timeout, send=b"AUTH TLS\r\n")
    has_tls    = tls_banner and "234" in tls_banner
    sev        = "medium" if has_tls else "high"
    detail     = f"FTP open. {'FTPS supported but not enforced.' if has_tls else 'No TLS support detected.'} Banner: {banner[:100]}"
    return [{
        "host": host, "check": "ftp", "severity": sev,
        "title": "FTP transmits credentials in cleartext" if not has_tls else "FTP without mandatory TLS",
        "detail": detail,
    }]


async def _check_smtp(host: str, timeout: float) -> list:
    findings = []
    for port in (25, 587):
        banner = await _banner(host, port, timeout)
        if not banner or not banner.startswith("220"):
            continue
        # Check STARTTLS support
        ehlo   = await _banner(host, port, timeout, send=b"EHLO msp-agent\r\n")
        has_tls = ehlo and "STARTTLS" in ehlo.upper()
        sev     = "medium" if has_tls else "high"
        findings.append({
            "host": host, "check": "smtp_plain", "severity": sev,
            "title": f"SMTP on port {port} {'without' if not has_tls else 'with optional'} STARTTLS",
            "detail": f"SMTP responds on port {port}. {'STARTTLS available but not enforced.' if has_tls else 'No STARTTLS support.'} Banner: {banner[:80]}",
        })
    return findings


async def _check_http_basic(host: str, timeout: float) -> list:
    findings = []
    for port in (80, 8080, 8000):
        if not await _port_open(host, port, timeout):
            continue
        try:
            r, w = await asyncio.wait_for(
                asyncio.open_connection(host, port), timeout=timeout
            )
            w.write(f"GET / HTTP/1.0\r\nHost: {host}\r\n\r\n".encode())
            await w.drain()
            resp = (await asyncio.wait_for(r.read(1024), timeout=timeout)).decode(errors="replace")
            w.close()
            if "401" in resp and "www-authenticate" in resp.lower() and "basic" in resp.lower():
                findings.append({
                    "host": host, "check": "http_basic", "severity": "high",
                    "title": f"HTTP Basic Auth over plaintext on port {port}",
                    "detail": f"Port {port} requires HTTP Basic Auth without TLS — credentials sent in cleartext.",
                })
        except Exception:
            pass
    return findings


async def _check_ldap(host: str, timeout: float) -> list:
    if not await _port_open(host, 389, timeout):
        return []
    return [{
        "host": host, "check": "ldap_plain", "severity": "medium",
        "title": "LDAP (plaintext) port open",
        "detail": "Port 389 is open. Verify LDAP traffic uses StartTLS or that LDAPS (636) is enforced.",
    }]


async def _check_vnc(host: str, timeout: float) -> list:
    banner = await _banner(host, 5900, timeout)
    if not banner or "RFB" not in banner:
        return []
    version = banner.strip()
    return [{
        "host": host, "check": "vnc", "severity": "high",
        "title": "VNC service open",
        "detail": f"VNC (port 5900) is accessible. Unencrypted remote desktop exposure. Protocol: {version[:40]}",
    }]


async def _check_x11(host: str, timeout: float) -> list:
    findings = []
    for port in range(6000, 6006):
        if await _port_open(host, port, timeout):
            findings.append({
                "host": host, "check": "x11", "severity": "high",
                "title": f"X11 display server open on port {port}",
                "detail": f"X11 forwarding port {port} is accessible — allows capturing screen/input.",
            })
            break  # One finding per host is enough
    return findings


async def _check_imap(host: str, timeout: float) -> list:
    banner = await _banner(host, 143, timeout)
    if not banner or "IMAP" not in banner.upper():
        return []
    cap  = await _banner(host, 143, timeout, send=b"a CAPABILITY\r\n")
    tls  = cap and "STARTTLS" in (cap.upper() if cap else "")
    sev  = "medium" if tls else "high"
    return [{
        "host": host, "check": "imap_plain", "severity": sev,
        "title": "IMAP without mandatory STARTTLS",
        "detail": f"Port 143 open. {'STARTTLS available but optional.' if tls else 'No STARTTLS support — credentials sent in cleartext.'}",
    }]


async def _check_pop3(host: str, timeout: float) -> list:
    banner = await _banner(host, 110, timeout)
    if not banner or not banner.startswith("+OK"):
        return []
    cap  = await _banner(host, 110, timeout, send=b"CAPA\r\n")
    tls  = cap and "STLS" in (cap.upper() if cap else "")
    sev  = "medium" if tls else "high"
    return [{
        "host": host, "check": "pop3_plain", "severity": sev,
        "title": "POP3 without mandatory STLS",
        "detail": f"Port 110 open. {'STLS available but optional.' if tls else 'No STLS support — credentials sent in cleartext.'}",
    }]


async def _check_snmp(host: str, timeout: float) -> list:
    """Detect SNMPv1/v2 by probing port 161 UDP — protocol version is a finding."""
    loop = asyncio.get_running_loop()
    try:
        open_ = await asyncio.wait_for(
            loop.run_in_executor(None, _udp_check, host, 161),
            timeout=timeout,
        )
        if open_:
            return [{
                "host": host, "check": "snmp_v1v2", "severity": "medium",
                "title": "SNMP port 161 open (possible v1/v2)",
                "detail": "SNMPv1/v2 use plaintext community strings. Verify SNMPv3 with auth/priv is used.",
            }]
    except Exception:
        pass
    return []


def _udp_check(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2)
            s.sendto(b'\x00', (host, port))
            s.recvfrom(64)
            return True
    except socket.timeout:
        return True  # No ICMP unreachable = likely open
    except Exception:
        return False
