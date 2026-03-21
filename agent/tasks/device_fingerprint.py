"""
Task: run_device_fingerprint
Discovers hosts on the network and infers device type by combining:
  - ARP scan (MAC address + OUI vendor from arp-scan's built-in database)
  - TCP port probing (common service ports → device signatures)
  - Reverse DNS hostname lookup
  - Vendor name pattern → device category mapping

Payload:
  targets:   CIDR or IP range (default: --localnet)
  interface: network interface (default: auto)
  timeout:   seconds per TCP probe (default: 2)
  deep:      bool — scan more ports for higher accuracy (slower, default: false)
"""

import asyncio
import logging
import re
import socket

logger = logging.getLogger(__name__)

# Port sets to probe per host
QUICK_PORTS = [22, 80, 443, 445, 548, 3389, 5900, 8080, 9100, 62078]
DEEP_PORTS  = QUICK_PORTS + [21, 23, 25, 53, 110, 143, 161, 8443, 49152]

# (vendor keyword list, device_type) — matched in order, first wins
VENDOR_TYPE_HINTS = [
    (["cisco", "juniper", "ubiquiti", "aruba", "mikrotik", "netgear", "zyxel",
      "fortinet", "palo alto", "tp-link", "linksys", "draytek", "edgecore"],  "network_device"),
    (["raspberry pi"],                                                          "linux_sbc"),
    (["apple"],                                                                 "apple_device"),
    (["samsung"],                                                               "mobile_or_tv"),
    (["brother", "xerox", "lexmark", "hp", "epson", "canon", "ricoh", "kyocera",
      "konica", "sharp", "oki data"],                                           "printer"),
    (["synology", "qnap", "buffalo", "western digital", "seagate"],            "nas"),
    (["amazon", "google", "roku", "nvidia shield"],                            "media_device"),
    (["espressif", "tuya", "shelly", "sonoff"],                                "iot_device"),
    (["vmware", "virtualbox", "proxmox"],                                      "virtual_machine"),
    (["dell", "lenovo", "asus", "acer", "gigabyte", "msi", "intel"],          "workstation"),
]

# Open port fingerprints → device type (port subset match, higher specificity first)
PORT_TYPE_MAP = [
    ({9100},           "printer"),
    ({62078},          "ios_device"),
    ({548},            "macos_device"),
    ({5900},           "vnc_host"),
    ({3389, 445},      "windows_host"),
    ({3389},           "windows_host"),
    ({445},            "windows_host"),
    ({22, 80, 443},    "linux_server"),
    ({22},             "linux_host"),
    ({80, 443},        "web_server"),
]


async def run(payload: dict) -> dict:
    interface = payload.get("interface", "")
    targets   = payload.get("targets", "--localnet")
    timeout   = float(payload.get("timeout", 2))
    deep      = bool(payload.get("deep", False))

    arp_hosts = await _arp_scan(interface, targets)
    if not arp_hosts:
        return {"devices_found": 0, "devices": []}

    ports = DEEP_PORTS if deep else QUICK_PORTS
    sem   = asyncio.Semaphore(20)

    async def enrich(host):
        async with sem:
            return await _enrich_host(host, ports, timeout)

    results  = await asyncio.gather(*[enrich(h) for h in arp_hosts], return_exceptions=True)
    devices  = [r for r in results if isinstance(r, dict)]

    return {
        "devices_found": len(devices),
        "devices":       devices,
    }


async def _arp_scan(interface: str, targets: str) -> list[dict]:
    cmd = ["arp-scan"]
    if interface:
        cmd += ["--interface", interface]
    if not targets or targets == "--localnet":
        cmd.append("--localnet")
    else:
        if not re.match(r'^[\d./]+$', str(targets)):
            raise ValueError(f"Invalid targets: {targets!r}")
        cmd.append(targets)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("arp-scan timed out after 60s")

    if proc.returncode != 0:
        raise RuntimeError(f"arp-scan failed (rc={proc.returncode})")

    hosts = []
    for line in stdout.decode().splitlines():
        parts = line.strip().split("\t")
        if len(parts) >= 2 and re.match(r'^\d+\.\d+\.\d+\.\d+$', parts[0]):
            hosts.append({
                "ip":     parts[0],
                "mac":    parts[1] if len(parts) > 1 else "",
                "vendor": parts[2] if len(parts) > 2 else "",
            })
    return hosts


async def _enrich_host(host: dict, ports: list[int], timeout: float) -> dict:
    ip     = host["ip"]
    vendor = host.get("vendor", "")

    hostname, open_ports = await asyncio.gather(
        _reverse_dns(ip),
        _probe_ports(ip, ports, timeout),
    )

    return {
        "ip":          ip,
        "mac":         host.get("mac", ""),
        "vendor":      vendor,
        "hostname":    hostname,
        "open_ports":  open_ports,
        "device_type": _infer_type(vendor, open_ports, hostname),
    }


async def _reverse_dns(ip: str) -> str | None:
    loop = asyncio.get_running_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(None, socket.gethostbyaddr, ip),
            timeout=2,
        )
        return result[0]
    except Exception:
        return None


async def _probe_ports(ip: str, ports: list[int], timeout: float) -> list[int]:
    async def check(port):
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout,
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return port
        except Exception:
            return None

    results = await asyncio.gather(*[check(p) for p in ports])
    return [p for p in results if p is not None]


def _infer_type(vendor: str, open_ports: list[int], hostname: str | None) -> str:
    vendor_lower = vendor.lower()
    host_lower   = (hostname or "").lower()
    port_set     = set(open_ports)

    # Port fingerprints (highest confidence)
    for pattern, dtype in PORT_TYPE_MAP:
        if pattern.issubset(port_set):
            return dtype

    # Vendor keyword matching
    for keywords, dtype in VENDOR_TYPE_HINTS:
        if any(kw in vendor_lower for kw in keywords):
            return dtype

    # Hostname heuristics
    for kw in ("router", "gateway", "switch", "ap", "access-point", "firewall"):
        if kw in host_lower:
            return "network_device"
    for kw in ("iphone", "ipad", "android", "mobile"):
        if kw in host_lower:
            return "mobile_device"
    for kw in ("nas", "storage", "diskstation", "readynas"):
        if kw in host_lower:
            return "nas"

    return "unknown_host" if open_ports else "unknown"
