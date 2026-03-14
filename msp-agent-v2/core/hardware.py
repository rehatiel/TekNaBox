"""
Hardware identity helpers for Linux-based MSP agent devices.
Works on Raspberry Pi, standard Debian/Ubuntu x86_64, and other Linux platforms.
"""

import subprocess
import hashlib
import os
import socket
import functools
import time


def get_cpu_serial() -> str:
    """
    Return a stable hardware identifier for this device.
    On Raspberry Pi: reads the unique CPU serial from /proc/cpuinfo.
    On all other Linux: falls back to a SHA256 hash of hostname + MAC address.
    """
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    serial = line.split(":")[1].strip()
                    if serial and serial != "0000000000000000":
                        return serial
    except Exception:
        pass
    # Fallback: hash of hostname + MAC
    try:
        hostname = socket.gethostname()
        mac = _get_mac_address()
        return hashlib.sha256(f"{hostname}-{mac}".encode()).hexdigest()[:16]
    except Exception:
        return "unknown"


def _get_mac_address() -> str:
    """Return MAC address of the best available non-loopback interface."""
    try:
        # Enumerate all interfaces, prefer one that is 'up'
        net_dir = "/sys/class/net"
        candidates = []
        for iface in os.listdir(net_dir):
            if iface == "lo":
                continue
            try:
                mac = open(f"{net_dir}/{iface}/address").read().strip()
                state = open(f"{net_dir}/{iface}/operstate").read().strip()
                if mac and mac != "00:00:00:00:00:00":
                    # up interfaces sort first
                    candidates.append((0 if state == "up" else 1, mac))
            except Exception:
                continue
        if candidates:
            candidates.sort()
            return candidates[0][1]
    except Exception:
        pass
    return "00:00:00:00:00:00"


@functools.lru_cache(maxsize=1)
def get_arch() -> str:
    """Return machine architecture string (e.g. x86_64, aarch64, armv7l). Cached."""
    import platform
    return platform.machine() or "unknown"


def get_uptime_seconds() -> int:
    try:
        with open("/proc/uptime") as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return 0


def get_memory_info() -> dict:
    info = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal"):
                    info["total_kb"] = int(line.split()[1])
                elif line.startswith("MemAvailable"):
                    info["available_kb"] = int(line.split()[1])
    except Exception:
        pass
    return info


def get_cpu_temp() -> float:
    """Return CPU temperature in Celsius."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000, 1)
    except Exception:
        return 0.0


def get_disk_info() -> dict:
    try:
        import shutil
        usage = shutil.disk_usage("/")
        return {
            "total_gb": round(usage.total / 1e9, 2),
            "used_gb": round(usage.used / 1e9, 2),
            "free_gb": round(usage.free / 1e9, 2),
        }
    except Exception:
        return {}


def get_cpu_usage_pct(interval: float = 0.2) -> float:
    """
    Return CPU usage as a percentage, sampled over `interval` seconds.
    Uses /proc/stat — no external dependencies.
    Falls back to 0.0 on any error.
    """
    def _read_stat() -> tuple[int, int]:
        try:
            with open("/proc/stat") as f:
                parts = f.readline().split()  # 'cpu  user nice system idle ...'
            values = [int(x) for x in parts[1:]]
            idle  = values[3]
            total = sum(values)
            return idle, total
        except Exception:
            return 0, 1

    idle1, total1 = _read_stat()
    time.sleep(interval)
    idle2, total2 = _read_stat()

    diff_total = total2 - total1
    diff_idle  = idle2  - idle1

    if diff_total == 0:
        return 0.0
    return round((1.0 - diff_idle / diff_total) * 100.0, 1)
