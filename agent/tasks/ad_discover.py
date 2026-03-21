"""
Task: run_ad_discover
Payload:
  targets: list of IPs or CIDR to scan for domain controllers
  timeout: per-host timeout (default: 30)

Stage 1 of AD recon — no credentials required.
Detects DCs via port scan + anonymous enumeration.
Returns domain name, DC IPs, and confidence score.
"""

import asyncio
import logging
import re
import xml.etree.ElementTree as ET

logger = logging.getLogger(__name__)

SAFE_TARGET_RE = re.compile(r'^[\d./,\s]+$')

# Ports that indicate an Active Directory / Windows domain environment
DC_PORTS = {
    88:   "Kerberos",
    389:  "LDAP",
    445:  "SMB",
    636:  "LDAPS",
    3268: "Global Catalog",
    3269: "Global Catalog SSL",
    135:  "RPC",
    139:  "NetBIOS",
}


async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    targets = [t.strip() for t in raw_targets if SAFE_TARGET_RE.match(str(t).strip())]
    if not targets:
        raise ValueError("No valid targets")

    timeout = int(payload.get("timeout", 30))

    # Step 1: nmap scan for DC-indicative ports
    dc_port_list = ",".join(str(p) for p in DC_PORTS.keys())
    cmd = [
        "nmap", "-p", dc_port_list,
        "--open", "--host-timeout", f"{timeout}s",
        "-oX", "-", "-T4",
    ] + targets

    logger.info(f"Scanning for domain controllers: {targets}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout * 3)

    if proc.returncode not in (0, 1):
        raise RuntimeError(f"nmap failed: {stderr.decode()[:200]}")

    candidates = _parse_dc_candidates(stdout.decode())

    # Step 2: For each candidate, get NetBIOS name and domain via smbclient/nmblookup
    domain_controllers = []
    for candidate in candidates:
        dc_info = await _probe_dc(candidate)
        domain_controllers.append(dc_info)

    # Determine most likely domain name
    domain_name = None
    for dc in domain_controllers:
        if dc.get("domain"):
            domain_name = dc["domain"]
            break

    return {
        "targets_scanned":   len(targets),
        "dc_candidates":     len(domain_controllers),
        "domain_name":       domain_name,
        "domain_controllers": domain_controllers,
        "recommendation":    _make_recommendation(domain_name, domain_controllers),
    }


def _parse_dc_candidates(xml_str: str) -> list:
    candidates = []
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError:
        return candidates

    for host in root.findall("host"):
        status = host.find("status")
        if status is None or status.get("state") != "up":
            continue

        addr_el = host.find("address[@addrtype='ipv4']")
        if addr_el is None:
            continue
        ip = addr_el.get("addr")

        open_ports = []
        dc_score   = 0
        for port_el in host.findall("ports/port"):
            state_el = port_el.find("state")
            if state_el is None or state_el.get("state") != "open":
                continue
            portid = int(port_el.get("portid"))
            open_ports.append(portid)
            if portid in DC_PORTS:
                # Kerberos + LDAP = very likely DC
                if portid in (88, 389):
                    dc_score += 3
                elif portid in (3268, 636):
                    dc_score += 2
                else:
                    dc_score += 1

        if dc_score >= 3:
            candidates.append({
                "ip":         ip,
                "open_ports": open_ports,
                "dc_score":   dc_score,
            })

    candidates.sort(key=lambda x: x["dc_score"], reverse=True)
    return candidates


async def _probe_dc(candidate: dict) -> dict:
    ip     = candidate["ip"]
    result = dict(candidate)
    result["domain"]       = None
    result["base_dn"]      = None
    result["os"]           = None
    result["netbios_name"] = None
    result["confidence"]   = "possible"

    # Try anonymous LDAP bind to get naming context
    if 389 in candidate.get("open_ports", []):
        domain, base_dn = await _ldap_anonymous(ip)
        if domain:
            result["domain"]    = domain
            result["base_dn"]   = base_dn
            result["confidence"] = "confirmed" if 88 in candidate.get("open_ports", []) else "likely"

    # Get NetBIOS name and domain via nmblookup / smbclient
    nb_name, nb_domain = await _enum4linux_basic(ip)
    if nb_name:
        result["netbios_name"] = nb_name
    if nb_domain and not result["domain"]:
        result["domain"] = nb_domain

    # SMB OS detection via nmap
    if 445 in candidate.get("open_ports", []):
        os_info = await _smb_os_detect(ip)
        if os_info:
            result["os"] = os_info

    return result


async def _ldap_anonymous(ip: str) -> tuple:
    """Attempt anonymous LDAP bind to get base DN / domain name."""
    cmd = [
        "ldapsearch",
        "-x",              # simple bind
        "-H", f"ldap://{ip}",
        "-s", "base",      # base scope only
        "-b", "",          # empty base = rootDSE
        "namingContexts", "defaultNamingContext",
        "dnsHostName", "ldapServiceName",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        output = stdout.decode()

        domain   = None
        base_dn  = None

        for line in output.splitlines():
            if "defaultNamingContext:" in line:
                dn = line.split(":", 1)[1].strip()
                base_dn = dn
                # Convert DC=corp,DC=local → corp.local
                parts = re.findall(r'DC=([^,]+)', dn, re.IGNORECASE)
                if parts:
                    domain = ".".join(parts).upper()
            elif "namingContexts:" in line and not base_dn:
                dn = line.split(":", 1)[1].strip()
                parts = re.findall(r'DC=([^,]+)', dn, re.IGNORECASE)
                if parts:
                    domain = ".".join(parts).upper()

        return domain, base_dn

    except Exception as e:
        logger.debug(f"LDAP probe failed for {ip}: {e}")
        return None, None


async def _enum4linux_basic(ip: str) -> tuple:
    """
    Get basic NetBIOS/domain info via smbclient (replaces enum4linux).
    Uses 'smbclient -L' with a null session — reads workgroup/domain from
    the server's SMB negotiation response. No enum4linux dependency.
    """
    netbios = None
    domain  = None

    # Try nmblookup first — fast, no SMB needed
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmblookup", "-A", ip,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        output = stdout.decode()
        for line in output.splitlines():
            m = re.match(r'\s+(\S+)\s+<00>', line)
            if m and not m.group(1).startswith("__"):
                name = m.group(1).strip()
                if "<GROUP>" not in line:
                    netbios = name
                else:
                    domain = name
        if netbios or domain:
            return netbios, domain
    except Exception:
        pass

    # Fallback: parse smbclient -L output for the workgroup line
    try:
        proc = await asyncio.create_subprocess_exec(
            "smbclient", "-L", ip, "-N", "--no-pass",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        combined = (stdout + stderr).decode(errors="replace")
        for line in combined.splitlines():
            # "Workgroup           Master"  or  "Domain=[EXAMPLE] ..."
            m = re.search(r'Domain=\[([^\]]+)\]', line)
            if m:
                domain = m.group(1).strip()
            m2 = re.match(r'\s*(\S+)\s+\S+\s*$', line)
            if m2 and not netbios and "Workgroup" not in line:
                netbios = m2.group(1)
    except Exception:
        pass

    return netbios, domain


async def _smb_os_detect(ip: str) -> str:
    cmd = ["nmap", "-p", "445", "--script", "smb-os-discovery", "-oG", "-", ip]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        output = stdout.decode()
        m = re.search(r'OS: ([^\|;]+)', output)
        return m.group(1).strip() if m else None
    except Exception:
        return None


def _make_recommendation(domain: str, dcs: list) -> str:
    if not dcs:
        return "No domain controllers detected in the target range."
    if domain:
        dc_ips = ", ".join(dc["ip"] for dc in dcs[:3])
        return (
            f"Domain '{domain}' detected. "
            f"Likely domain controller(s): {dc_ips}. "
            f"Enter domain credentials in the AD Report page to run full recon."
        )
    return (
        f"Possible domain environment detected ({len(dcs)} candidate(s)) "
        f"but domain name could not be determined. "
        f"Try entering credentials manually."
    )
