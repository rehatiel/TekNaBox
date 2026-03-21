"""
Task: run_snmp_query
Payload:
  target: IP or hostname
  community: SNMP community string (default: "public")
  version: "1" | "2c" | "3" (default: "2c")
  mode: "sysinfo" | "interfaces" | "storage" | "full" | "custom" (default: sysinfo)
  oids: list of OIDs for custom mode e.g. ["1.3.6.1.2.1.1.1.0"]

Requires: snmp package (snmpwalk, snmpget)
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')

# Standard OID sets
SYSINFO_OIDS = {
    "sysDescr":        "1.3.6.1.2.1.1.1.0",
    "sysObjectID":     "1.3.6.1.2.1.1.2.0",
    "sysUpTime":       "1.3.6.1.2.1.1.3.0",
    "sysContact":      "1.3.6.1.2.1.1.4.0",
    "sysName":         "1.3.6.1.2.1.1.5.0",
    "sysLocation":     "1.3.6.1.2.1.1.6.0",
}

WALK_OIDS = {
    "interfaces":  "1.3.6.1.2.1.2.2",   # ifTable
    "storage":     "1.3.6.1.2.1.25.2",  # hrStorageTable
    "processes":   "1.3.6.1.2.1.25.4.2",# hrSWRunTable (trimmed)
}


async def run(payload: dict) -> dict:
    target    = payload.get("target", "")
    if not target or not SAFE_HOST_RE.match(target):
        raise ValueError(f"Invalid target: {target!r}")

    community = payload.get("community", "public")
    version   = payload.get("version", "2c")
    mode      = payload.get("mode", "sysinfo")
    custom_oids = payload.get("oids", [])

    result = {"target": target, "version": version}  # community string intentionally omitted from result

    if mode in ("sysinfo", "full"):
        sysinfo = {}
        for name, oid in SYSINFO_OIDS.items():
            val = await _snmpget(target, community, version, oid)
            if val:
                sysinfo[name] = val
        result["sysinfo"] = sysinfo

    if mode in ("interfaces", "full"):
        out = await _snmpwalk(target, community, version, WALK_OIDS["interfaces"])
        result["interfaces"] = _parse_interfaces(out)

    if mode in ("storage", "full"):
        out = await _snmpwalk(target, community, version, WALK_OIDS["storage"])
        result["storage"] = _parse_storage(out)

    if mode == "custom" and custom_oids:
        custom_results = {}
        for oid in custom_oids[:20]:  # cap at 20
            val = await _snmpget(target, community, version, str(oid))
            custom_results[oid] = val
        result["custom"] = custom_results

    return result


async def _snmpget(target: str, community: str, version: str, oid: str) -> str:
    cmd = ["snmpget", "-v", version, "-c", community, "-Ov", "-OQ", target, oid]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        return stdout.decode().strip().strip('"')
    except Exception:
        return None


async def _snmpwalk(target: str, community: str, version: str, base_oid: str) -> str:
    cmd = ["snmpwalk", "-v", version, "-c", community, "-OQ", "-Ov", target, base_oid]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        return stdout.decode()
    except Exception:
        return ""


def _parse_interfaces(output: str) -> list:
    """Parse ifTable walk into interface list."""
    values = {}
    for line in output.splitlines():
        line = line.strip()
        if "=" in line:
            parts = line.split("=", 1)
            values[parts[0].strip()] = parts[1].strip().strip('"')

    # Group by index — rough approach
    interfaces = {}
    for key, val in values.items():
        m = re.search(r'\.(\d+)$', key)
        if not m:
            continue
        idx = m.group(1)
        if idx not in interfaces:
            interfaces[idx] = {"index": idx}
        if "ifDescr" in key:
            interfaces[idx]["name"] = val
        elif "ifType" in key:
            interfaces[idx]["type"] = val
        elif "ifSpeed" in key:
            try:
                interfaces[idx]["speed_mbps"] = int(val) // 1_000_000
            except ValueError:
                pass
        elif "ifOperStatus" in key:
            interfaces[idx]["status"] = "up" if val == "1" else "down"
        elif "ifPhysAddress" in key:
            interfaces[idx]["mac"] = val

    return list(interfaces.values())


def _parse_storage(output: str) -> list:
    """Parse hrStorageTable into storage list."""
    values = {}
    for line in output.splitlines():
        line = line.strip()
        if "=" in line:
            parts = line.split("=", 1)
            values[parts[0].strip()] = parts[1].strip().strip('"')

    storages = {}
    for key, val in values.items():
        m = re.search(r'\.(\d+)$', key)
        if not m:
            continue
        idx = m.group(1)
        if idx not in storages:
            storages[idx] = {"index": idx}
        if "hrStorageDescr" in key:
            storages[idx]["description"] = val
        elif "hrStorageSize" in key:
            try:
                storages[idx]["size_units"] = int(val)
            except ValueError:
                pass
        elif "hrStorageUsed" in key:
            try:
                storages[idx]["used_units"] = int(val)
            except ValueError:
                pass
        elif "hrStorageAllocationUnits" in key:
            try:
                storages[idx]["unit_bytes"] = int(val)
            except ValueError:
                pass

    # Calculate sizes in MB
    result = []
    for s in storages.values():
        unit = s.get("unit_bytes", 1)
        size = s.get("size_units", 0) * unit
        used = s.get("used_units", 0) * unit
        if size > 0:
            result.append({
                "description": s.get("description", ""),
                "size_mb":     round(size / 1024 / 1024, 1),
                "used_mb":     round(used / 1024 / 1024, 1),
                "free_mb":     round((size - used) / 1024 / 1024, 1),
                "used_pct":    round(used / size * 100, 1) if size else 0,
            })
    return result
