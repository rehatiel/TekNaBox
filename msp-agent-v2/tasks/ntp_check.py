"""
Task: run_ntp_check
Payload:
  servers: list of NTP server IPs/hostnames to query (default: common public servers)
  warn_offset_ms: flag as drifted if offset exceeds this (default: 500ms)
  check_peers: list of device IPs to also check (optional)

Checks NTP sync status of this device and optionally other hosts.
Pure Python — no external dependencies.
Uses raw NTP UDP packets (RFC 5905).
"""

import asyncio
import logging
import socket
import struct
import time

logger = logging.getLogger(__name__)

DEFAULT_NTP_SERVERS = [
    "pool.ntp.org",
    "time.cloudflare.com",
    "time.google.com",
]

# NTP epoch offset (seconds between 1900-01-01 and 1970-01-01)
NTP_DELTA = 2208988800


async def run(payload: dict) -> dict:
    servers       = payload.get("servers") or DEFAULT_NTP_SERVERS
    warn_offset   = float(payload.get("warn_offset_ms", 500))
    check_peers   = payload.get("check_peers", [])

    loop    = asyncio.get_running_loop()
    results = []

    # Query each NTP server
    for server in servers[:6]:
        r = await asyncio.wait_for(
            loop.run_in_executor(None, _query_ntp, server),
            timeout=8,
        )
        results.append(r)

    # Local system clock sync status
    local_sync = await loop.run_in_executor(None, _check_local_sync)

    # Check peer devices if requested
    peer_results = []
    if check_peers:
        peer_tasks = [
            loop.run_in_executor(None, _query_ntp_peer, str(ip))
            for ip in check_peers[:10]
        ]
        peer_results = await asyncio.gather(*peer_tasks, return_exceptions=True)
        peer_results = [
            r if not isinstance(r, Exception) else {"error": str(r)}
            for r in peer_results
        ]

    # Best offset from successful queries
    successful = [r for r in results if r.get("offset_ms") is not None]
    avg_offset = None
    if successful:
        avg_offset = round(sum(r["offset_ms"] for r in successful) / len(successful), 2)

    status = "ok"
    if avg_offset is None:
        status = "error"
    elif abs(avg_offset) > warn_offset:
        status = "drifted"
    elif not local_sync.get("synchronized"):
        status = "not_synchronized"

    return {
        "status":          status,
        "avg_offset_ms":   avg_offset,
        "warn_offset_ms":  warn_offset,
        "local_sync":      local_sync,
        "server_results":  results,
        "peer_results":    peer_results,
    }


def _query_ntp(server: str) -> dict:
    """Send NTP client request and measure offset."""
    result = {"server": server}
    try:
        # NTP request packet: LI=0, VN=3, Mode=3 (client)
        packet = b'\x1b' + 47 * b'\0'
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(4)
            t1 = time.time()
            s.sendto(packet, (socket.gethostbyname(server), 123))
            data, _ = s.recvfrom(1024)
            t4 = time.time()

        if len(data) < 48:
            result["error"] = "Short response"
            return result

        # Unpack transmit timestamp (bytes 40-47)
        t3_int, t3_frac = struct.unpack("!II", data[40:48])
        t3 = t3_int - NTP_DELTA + t3_frac / 2**32

        # Round-trip delay and offset
        rtt_ms    = round((t4 - t1) * 1000, 2)
        offset_ms = round(((t3 - t1) + (t3 - t4)) / 2 * 1000, 2)

        result.update({
            "reachable":  True,
            "rtt_ms":     rtt_ms,
            "offset_ms":  offset_ms,
            "stratum":    data[1] if len(data) > 1 else None,
        })

    except socket.timeout:
        result["error"] = "Timeout"
    except OSError as e:
        result["error"] = str(e)[:100]

    return result


def _query_ntp_peer(host: str) -> dict:
    """Check if a peer device is reachable on NTP port."""
    r = _query_ntp(host)
    r["host"] = host
    return r


def _check_local_sync() -> dict:
    """Check local system NTP synchronization status via timedatectl."""
    import subprocess
    result = {"synchronized": None, "source": None, "offset_ms": None}
    try:
        r = subprocess.run(
            ["timedatectl", "show", "--no-pager"],
            capture_output=True, text=True, timeout=5,
        )
        for line in r.stdout.splitlines():
            if "NTPSynchronized=" in line:
                result["synchronized"] = "yes" in line.lower()
            if "TimeUSec=" in line or "NTPMessage=" in line:
                pass  # extra info available but not parsed here
        # Also check ntpq if timedatectl gives nothing
        if result["synchronized"] is None:
            r2 = subprocess.run(
                ["ntpq", "-p"],
                capture_output=True, text=True, timeout=5,
            )
            if r2.returncode == 0 and r2.stdout:
                result["synchronized"] = True
                # Find the * peer (selected)
                for line in r2.stdout.splitlines():
                    if line.startswith("*"):
                        parts = line.split()
                        result["source"] = parts[0].lstrip("*")
                        if len(parts) >= 9:
                            try:
                                result["offset_ms"] = float(parts[8])
                            except ValueError:
                                pass
    except Exception as e:
        result["error"] = str(e)[:100]
    return result
