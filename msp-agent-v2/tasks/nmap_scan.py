"""
Task: run_nmap_scan
Payload:
  targets: list of IPs/CIDRs e.g. ["10.0.0.0/24"]
  ports: port range string e.g. "1-1024" or "22,80,443"
  scan_type: "quick" | "service" | "os"  (default: quick)
"""

import asyncio
import logging
import re
import xml.etree.ElementTree as ET

logger = logging.getLogger(__name__)

SAFE_TARGET_RE = re.compile(r'^[\d./,\s-]+$')


def _validate_targets(targets: list) -> list:
    safe = []
    for t in targets:
        t = str(t).strip()
        if SAFE_TARGET_RE.match(t):
            safe.append(t)
        else:
            logger.warning(f"Rejected unsafe nmap target: {t!r}")
    return safe


async def run(payload: dict) -> dict:
    targets = _validate_targets(payload.get("targets", []))
    if not targets:
        raise ValueError("No valid targets provided")

    ports = payload.get("ports", "1-1024")
    scan_type = payload.get("scan_type", "quick")

    # Validate ports string
    if not re.match(r'^[\d,\-]+$', str(ports)):
        raise ValueError(f"Invalid ports value: {ports}")

    cmd = ["nmap", "-oX", "-", "--host-timeout", "30s"]

    if scan_type == "service":
        cmd += ["-sV", "--version-intensity", "2"]
    elif scan_type == "os":
        cmd += ["-O", "--osscan-limit"]
    else:
        cmd += ["-T4"]

    cmd += ["-p", str(ports)] + targets

    logger.info(f"Running nmap: {' '.join(cmd)}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    # --host-timeout 30s applies per host, but the overall process needs its own ceiling
    overall_timeout = 30 * len(targets) + 30
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=overall_timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"nmap timed out after {overall_timeout}s")

    if proc.returncode not in (0, 1):  # nmap returns 1 if no hosts up
        raise RuntimeError(f"nmap failed (rc={proc.returncode}): {stderr.decode()[:500]}")

    return _parse_nmap_xml(stdout.decode())


def _parse_nmap_xml(xml_str: str) -> dict:
    """Parse nmap XML output into a clean dict."""
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError as e:
        return {"raw": xml_str[:2000], "parse_error": str(e)}

    hosts = []
    for host in root.findall("host"):
        status = host.find("status")
        if status is None or status.get("state") != "up":
            continue

        addr_el = host.find("address")
        ip = addr_el.get("addr") if addr_el is not None else "unknown"

        hostname_el = host.find("hostnames/hostname")
        hostname = hostname_el.get("name") if hostname_el is not None else None

        ports = []
        for port in host.findall("ports/port"):
            state_el = port.find("state")
            if state_el is None or state_el.get("state") != "open":
                continue
            service_el = port.find("service")
            port_info = {
                "port": int(port.get("portid")),
                "protocol": port.get("protocol"),
                "service": service_el.get("name") if service_el is not None else None,
                "version": service_el.get("version") if service_el is not None else None,
            }
            ports.append(port_info)

        hosts.append({
            "ip": ip,
            "hostname": hostname,
            "open_ports": ports,
            "open_port_count": len(ports),
        })

    return {
        "hosts_up": len(hosts),
        "hosts": hosts,
    }
