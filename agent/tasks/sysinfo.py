"""
Task: get_sysinfo
Returns comprehensive system information from the Pi.
No payload required.
"""

import asyncio
import logging
import os
import platform
import socket
import subprocess

from core.hardware import (
    get_cpu_serial, get_arch, get_uptime_seconds,
    get_memory_info, get_cpu_temp, get_disk_info,
)

logger = logging.getLogger(__name__)


async def run(payload: dict) -> dict:
    loop = asyncio.get_running_loop()
    info = {}

    # Basic system
    info["hostname"] = socket.gethostname()
    info["platform"] = platform.platform()
    info["arch"] = get_arch()
    info["cpu_serial"] = get_cpu_serial()
    info["uptime_seconds"] = get_uptime_seconds()
    info["cpu_temp_c"] = get_cpu_temp()
    info["memory"] = get_memory_info()
    info["disk"] = get_disk_info()

    # Network interfaces
    info["interfaces"] = await loop.run_in_executor(None, _get_interfaces)

    # Default gateway
    info["default_gateway"] = await loop.run_in_executor(None, _get_default_gateway)

    # DNS servers
    info["dns_servers"] = await loop.run_in_executor(None, _get_dns_servers)

    # WiFi info
    info["wifi"] = await loop.run_in_executor(None, _get_wifi_info)

    # Running processes count
    try:
        info["process_count"] = len(os.listdir("/proc")) - 1
    except Exception:
        pass

    # Kernel version
    info["kernel"] = platform.release()

    return info


def _get_interfaces() -> list:
    interfaces = []
    try:
        result = subprocess.run(
            ["ip", "-j", "addr"], capture_output=True, text=True, timeout=5
        )
        import json
        ifaces = json.loads(result.stdout)
        for iface in ifaces:
            entry = {
                "name": iface.get("ifname"),
                "state": iface.get("operstate"),
                "mac": iface.get("address"),
                "addresses": [
                    {"addr": a.get("local"), "prefix": a.get("prefixlen"), "family": a.get("family")}
                    for a in iface.get("addr_info", [])
                ],
            }
            interfaces.append(entry)
    except Exception as e:
        logger.debug(f"Could not get interfaces: {e}")
    return interfaces


def _get_default_gateway() -> str:
    try:
        result = subprocess.run(
            ["ip", "route", "show", "default"],
            capture_output=True, text=True, timeout=5
        )
        parts = result.stdout.strip().split()
        if "via" in parts:
            return parts[parts.index("via") + 1]
    except Exception:
        pass
    return None


def _get_dns_servers() -> list:
    servers = []
    try:
        with open("/etc/resolv.conf") as f:
            for line in f:
                if line.startswith("nameserver"):
                    servers.append(line.split()[1])
    except Exception:
        pass
    return servers


def _find_wireless_interface() -> str | None:
    """Return the name of the first wireless interface found, or None."""
    try:
        import os
        # /sys/class/net/<iface>/wireless exists for WiFi interfaces
        for iface in os.listdir("/sys/class/net"):
            if os.path.isdir(f"/sys/class/net/{iface}/wireless"):
                return iface
    except Exception:
        pass
    return None


def _get_wifi_info() -> dict:
    iface = _find_wireless_interface()
    if not iface:
        return {}
    try:
        result = subprocess.run(
            ["iwconfig", iface], capture_output=True, text=True, timeout=5
        )
        output = result.stdout
        info = {"interface": iface}

        import re
        ssid_match = re.search(r'ESSID:"([^"]*)"', output)
        if ssid_match:
            info["ssid"] = ssid_match.group(1)

        quality_match = re.search(r'Link Quality=(\d+)/(\d+)', output)
        if quality_match:
            info["link_quality"] = f"{quality_match.group(1)}/{quality_match.group(2)}"
            info["link_quality_pct"] = round(
                int(quality_match.group(1)) / int(quality_match.group(2)) * 100
            )

        signal_match = re.search(r'Signal level=(-?\d+) dBm', output)
        if signal_match:
            info["signal_dbm"] = int(signal_match.group(1))

        freq_match = re.search(r'Frequency:(\S+)', output)
        if freq_match:
            info["frequency"] = freq_match.group(1)

        return info
    except Exception:
        return {}
