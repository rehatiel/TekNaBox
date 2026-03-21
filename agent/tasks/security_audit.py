"""
Task: run_security_audit
Payload:
  targets: list of IPs to audit
  checks: list of checks to run (default: all)
    - "open_telnet"       — Telnet open (port 23)
    - "ftp_anonymous"     — Anonymous FTP login
    - "snmp_default"      — SNMP public/private community
    - "smb_signing"       — SMB signing disabled
    - "open_rdp"          — RDP exposed (port 3389)
    - "weak_ssh"          — SSH service detected
    - "dns_open_resolver" — DNS open resolver

Read-only checks only — no exploitation.
All per-target checks run concurrently; targets themselves are also batched.
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_TARGET_RE = re.compile(r'^[\d.]+$')

ALL_CHECKS = [
    "open_telnet", "ftp_anonymous", "snmp_default", "smb_signing",
    "open_rdp", "weak_ssh", "dns_open_resolver",
]


async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    targets     = [t.strip() for t in raw_targets if SAFE_TARGET_RE.match(str(t).strip())]
    if not targets:
        raise ValueError("No valid targets")

    checks = payload.get("checks", ALL_CHECKS)

    # Run all targets concurrently (capped at 20, with an internal semaphore for courtesy)
    sem = asyncio.Semaphore(10)

    async def check_one(target):
        async with sem:
            return await _check_target(target, checks)

    per_target = await asyncio.gather(
        *[check_one(t) for t in targets[:20]],
        return_exceptions=False,
    )

    findings = []
    for r in per_target:
        findings.extend(r.get("findings", []))

    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    findings.sort(key=lambda f: sev_order.get(f.get("severity", "info"), 4))

    return {
        "targets_checked": len(per_target),
        "findings_count":  len(findings),
        "findings":        findings,
        "by_target":       per_target,
        "summary": {
            "critical": sum(1 for f in findings if f.get("severity") == "critical"),
            "high":     sum(1 for f in findings if f.get("severity") == "high"),
            "medium":   sum(1 for f in findings if f.get("severity") == "medium"),
            "low":      sum(1 for f in findings if f.get("severity") == "low"),
        },
    }


async def _check_target(target: str, checks: list) -> dict:
    """Run all requested checks against a single target concurrently."""
    subtasks = []
    if "open_telnet"       in checks: subtasks.append(_check_telnet(target))
    if "ftp_anonymous"     in checks: subtasks.append(_check_ftp_anonymous(target))
    if "snmp_default"      in checks: subtasks.append(_check_snmp_default(target))
    if "open_rdp"          in checks: subtasks.append(_check_open_port(target, 3389, "RDP exposed", "medium"))
    if "weak_ssh"          in checks: subtasks.append(_check_ssh_config(target))
    if "dns_open_resolver" in checks: subtasks.append(_check_dns_resolver(target))
    if "smb_signing"       in checks: subtasks.append(_check_smb_signing(target))

    results = await asyncio.gather(*subtasks, return_exceptions=True)

    findings = []
    for r in results:
        if isinstance(r, Exception):
            logger.debug(f"Check failed for {target}: {r}")
            continue
        if r is None:
            continue
        if isinstance(r, list):
            findings.extend(r)
        else:
            findings.append(r)

    return {"ip": target, "findings": findings}


# ── Individual checks ─────────────────────────────────────────────────────────

async def _check_telnet(target: str):
    if await _port_open(target, 23):
        banner = await _get_banner(target, 23)
        return {
            "ip": target, "check": "open_telnet", "severity": "high",
            "title": "Telnet service open",
            "detail": f"Port 23 open. Telnet transmits credentials in cleartext. Banner: {banner[:100]}",
        }
    return None


async def _check_ftp_anonymous(target: str):
    if not await _port_open(target, 21):
        return None
    reader = writer = None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(target, 21), timeout=5)
        await asyncio.wait_for(reader.read(256), timeout=3)
        writer.write(b"USER anonymous\r\n"); await writer.drain()
        resp1 = (await asyncio.wait_for(reader.read(256), timeout=3)).decode(errors="replace")
        if "331" in resp1:
            writer.write(b"PASS anonymous@\r\n"); await writer.drain()
            resp2 = (await asyncio.wait_for(reader.read(256), timeout=3)).decode(errors="replace")
            if "230" in resp2:
                return {
                    "ip": target, "check": "ftp_anonymous", "severity": "high",
                    "title": "FTP anonymous login allowed",
                    "detail": "FTP server accepts anonymous login — unauthenticated file access possible.",
                }
    except Exception:
        pass
    finally:
        if writer:
            try: writer.close(); await writer.wait_closed()
            except Exception: pass
    return None


async def _check_snmp_default(target: str):
    findings = []
    tasks = [_try_snmp_community(target, c) for c in ("public", "private", "community", "snmp")]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for r in results:
        if r and not isinstance(r, Exception):
            findings.append(r)
    return findings


async def _try_snmp_community(target: str, community: str):
    try:
        proc = await asyncio.create_subprocess_exec(
            "snmpget", "-v", "2c", "-c", community, "-t", "2", "-r", "0",
            target, "1.3.6.1.2.1.1.1.0",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        if proc.returncode == 0 and stdout:
            return {
                "ip": target, "check": "snmp_default", "severity": "high",
                "title": f"SNMP default community string: '{community}'",
                "detail": f"SNMP community '{community}' accepted. Device info: {stdout.decode().strip()[:150]}",
            }
    except Exception:
        pass
    return None


async def _check_ssh_config(target: str):
    if not await _port_open(target, 22):
        return None
    banner = await _get_banner(target, 22)
    if banner:
        return {
            "ip": target, "check": "weak_ssh", "severity": "info",
            "title": "SSH service detected",
            "detail": f"SSH banner: {banner[:150]}. Verify password auth and root login are disabled.",
        }
    return None


async def _check_dns_resolver(target: str):
    if not await _port_open(target, 53):
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "dig", "+short", "+time=3", "+tries=1", f"@{target}", "google.com", "A",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        output = stdout.decode().strip()
        if output and re.match(r'[\d.]+', output):
            return {
                "ip": target, "check": "dns_open_resolver", "severity": "medium",
                "title": "DNS open resolver",
                "detail": "Host resolves external names — can be used for DNS amplification attacks.",
            }
    except Exception:
        pass
    return None


async def _check_smb_signing(target: str):
    if not await _port_open(target, 445):
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmap", "-p", "445", "--script", "smb-security-mode", "-oG", "-", target,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        if "message_signing: disabled" in stdout.decode().lower():
            return {
                "ip": target, "check": "smb_signing", "severity": "medium",
                "title": "SMB signing disabled",
                "detail": "SMB message signing disabled — susceptible to NTLM relay attacks.",
            }
    except Exception:
        pass
    return None


async def _check_open_port(target: str, port: int, title: str, severity: str):
    if await _port_open(target, port):
        return {
            "ip": target, "check": f"open_port_{port}", "severity": severity,
            "title": title, "detail": f"Port {port} is open and reachable.",
        }
    return None


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _port_open(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        writer.close()
        try: await writer.wait_closed()
        except Exception: pass
        return True
    except Exception:
        return False


async def _get_banner(host: str, port: int, timeout: float = 3.0) -> str:
    reader = writer = None
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
        data = await asyncio.wait_for(reader.read(256), timeout=timeout)
        return data.decode(errors="replace").strip()
    except Exception:
        return ""
    finally:
        if writer:
            try: writer.close(); await writer.wait_closed()
            except Exception: pass
