"""
Task: run_netbios_scan
Payload:
  targets: list of IPs or CIDR ranges e.g. ["192.168.1.0/24"]
  timeout: per-host timeout in seconds (default: 2)

Performs fast NetBIOS/NBNS enumeration to discover Windows machine names,
workgroups, and domain membership without credentials.
Uses nmblookup if available, falls back to raw UDP NBNS queries.
"""

import asyncio
import logging
import re
import socket
import struct

logger = logging.getLogger(__name__)

SAFE_TARGET_RE = re.compile(r'^[\d./]+$')

# NetBIOS name service port
NBNS_PORT = 137


async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    timeout     = float(payload.get("timeout", 2))

    ips = []
    for t in raw_targets:
        t = str(t).strip()
        if not SAFE_TARGET_RE.match(t):
            continue
        ips.extend(_expand_target(t))

    if not ips:
        raise ValueError("No valid targets provided")

    # Deduplicate and cap
    ips = list(dict.fromkeys(ips))[:254]

    results = await asyncio.gather(
        *[_query_host(ip, timeout) for ip in ips],
        return_exceptions=False,
    )

    found = [r for r in results if r.get("names")]

    return {
        "hosts_queried":   len(ips),
        "hosts_found":     len(found),
        "hosts":           found,
        "all_results":     results,
    }


def _expand_target(target: str) -> list[str]:
    """Expand a CIDR or single IP to a list of host IPs."""
    if "/" not in target:
        return [target]
    try:
        import ipaddress
        net  = ipaddress.ip_network(target, strict=False)
        # Skip network and broadcast, cap at /23 for sanity
        if net.num_addresses > 512:
            logger.warning(f"Target {target} is too large — capping at 512 hosts")
        return [str(ip) for ip in list(net.hosts())[:512]]
    except Exception:
        return [target]


async def _query_host(ip: str, timeout: float) -> dict:
    result = {"ip": ip, "names": [], "mac": None, "reachable": False}
    loop   = asyncio.get_running_loop()

    # Try nmblookup first (fast, clean output)
    try:
        r = await asyncio.wait_for(
            loop.run_in_executor(None, _nmblookup, ip),
            timeout=timeout + 1,
        )
        if r:
            result.update(r)
            return result
    except Exception:
        pass

    # Fallback: raw NBNS status query
    try:
        r = await asyncio.wait_for(
            loop.run_in_executor(None, _raw_nbns_query, ip),
            timeout=timeout + 1,
        )
        if r:
            result.update(r)
    except Exception:
        pass

    return result


def _nmblookup(ip: str) -> dict | None:
    import subprocess
    try:
        r = subprocess.run(
            ["nmblookup", "-A", ip],
            capture_output=True, text=True, timeout=4,
        )
        if r.returncode != 0 or "No reply" in r.stdout:
            return None
        return _parse_nmblookup(r.stdout, ip)
    except FileNotFoundError:
        return None
    except Exception:
        return None


def _parse_nmblookup(output: str, ip: str) -> dict | None:
    names   = []
    mac     = None
    is_dc   = False

    for line in output.splitlines():
        line = line.strip()

        # MAC address
        m = re.search(r'MAC Address = ([0-9A-F:]+)', line, re.I)
        if m:
            mac = m.group(1)
            continue

        # Name entry: "    HOSTNAME          <00> -         M <ACTIVE>"
        m = re.match(
            r'(\S+)\s+<([0-9a-fA-F]{2})>\s+-?\s+(\S+)\s+<(\w+)>',
            line,
        )
        if m:
            name, code, flag, status = m.groups()
            if status != "ACTIVE":
                continue
            code_int = int(code, 16)
            role     = _nbns_code_to_role(code_int, flag)
            if code_int == 0x1C:
                is_dc = True
            names.append({
                "name":   name,
                "code":   f"<{code}>",
                "role":   role,
                "group":  flag == "G",
            })

    if not names:
        return None

    # Best hostname: first unique name (code 0x00, not group)
    hostname = next(
        (n["name"] for n in names if n["code"] == "<00>" and not n["group"]),
        names[0]["name"] if names else None,
    )
    # Workgroup: first group name with code 0x00
    workgroup = next(
        (n["name"] for n in names if n["code"] == "<00>" and n["group"]),
        None,
    )

    return {
        "reachable": True,
        "hostname":  hostname,
        "workgroup": workgroup,
        "is_dc":     is_dc,
        "mac":       mac,
        "names":     names,
    }


def _nbns_code_to_role(code: int, flag: str) -> str:
    CODES = {
        0x00: "Workstation (Group)" if flag == "G" else "Workstation",
        0x03: "Messenger service",
        0x06: "RAS server",
        0x1B: "Domain master browser",
        0x1C: "Domain controller",
        0x1D: "Master browser",
        0x1E: "Browser election",
        0x20: "File server",
        0x21: "RAS client",
    }
    return CODES.get(code, f"Unknown <{code:02x}>")


def _raw_nbns_query(ip: str) -> dict | None:
    """Send a raw NetBIOS Node Status Request (RFC 1002)."""
    # Transaction ID: 0x0001
    # Flags: 0x0010 (NB_STAT request)
    # QDCOUNT=1, all others 0
    # Question: * <NBSTAT>
    header = struct.pack("!HHHHHH", 0x0001, 0x0010, 1, 0, 0, 0)
    # Encoded "*" name: 32 bytes of "CA" + null label
    name   = b'\x20' + b'CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' + b'\x00'
    qtype  = struct.pack("!HH", 0x0021, 0x0001)  # NBSTAT, IN
    packet = header + name + qtype

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(3)
            s.sendto(packet, (ip, NBNS_PORT))
            data, _ = s.recvfrom(1024)
    except Exception:
        return None

    return _parse_nbns_response(data, ip)


def _parse_nbns_response(data: bytes, ip: str) -> dict | None:
    if len(data) < 57:
        return None
    try:
        num_names = data[56]
        names     = []
        offset    = 57
        for _ in range(num_names):
            if offset + 18 > len(data):
                break
            raw_name = data[offset:offset + 15].decode("ascii", errors="replace").rstrip()
            code     = data[offset + 15]
            flags    = struct.unpack("!H", data[offset + 16:offset + 18])[0]
            is_group = bool(flags & 0x8000)
            role     = _nbns_code_to_role(code, "G" if is_group else "U")
            names.append({
                "name":  raw_name,
                "code":  f"<{code:02x}>",
                "role":  role,
                "group": is_group,
            })
            offset += 18

        # MAC from last 6 bytes
        mac = None
        if len(data) >= offset + 6:
            mac_bytes = data[offset:offset + 6]
            mac = ":".join(f"{b:02X}" for b in mac_bytes)
            if mac == "00:00:00:00:00:00":
                mac = None

        hostname  = next((n["name"] for n in names if n["code"] == "<00>" and not n["group"]), None)
        workgroup = next((n["name"] for n in names if n["code"] == "<00>" and n["group"]), None)

        return {
            "reachable": True,
            "hostname":  hostname,
            "workgroup": workgroup,
            "is_dc":     any(n["code"] == "<1c>" for n in names),
            "mac":       mac,
            "names":     names,
        }
    except Exception:
        return None
