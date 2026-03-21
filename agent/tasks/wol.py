"""
Task: run_wol
Payload:
  targets: list of {mac, broadcast} dicts or "mac" strings
           broadcast defaults to 255.255.255.255
  count: number of magic packets to send per target (default: 3)
  interval_ms: ms between packets (default: 100)

Sends Wake-on-LAN magic packets.
No dependencies — pure Python UDP broadcast.
"""

import asyncio
import logging
import re
import socket

logger = logging.getLogger(__name__)

MAC_RE = re.compile(r'^([0-9A-Fa-f]{2}[:\-]?){5}[0-9A-Fa-f]{2}$')


async def run(payload: dict) -> dict:
    raw      = payload.get("targets", [])
    count    = min(int(payload.get("count", 3)), 10)
    interval = min(float(payload.get("interval_ms", 100)), 1000) / 1000.0

    targets = _parse_targets(raw)
    if not targets:
        raise ValueError("No valid MAC addresses provided")

    results = []
    for mac, broadcast in targets:
        r = await _send_wol(mac, broadcast, count, interval)
        results.append(r)

    return {
        "targets":  len(results),
        "sent":     sum(1 for r in results if r.get("sent")),
        "results":  results,
    }


def _parse_targets(raw: list) -> list[tuple[str, str]]:
    out = []
    for item in raw:
        if isinstance(item, str):
            mac       = item.strip()
            broadcast = "255.255.255.255"
        elif isinstance(item, dict):
            mac       = str(item.get("mac", "")).strip()
            broadcast = str(item.get("broadcast", "255.255.255.255")).strip()
        else:
            continue

        mac_clean = mac.replace("-", ":").upper()
        if not MAC_RE.match(mac_clean):
            logger.warning(f"Skipping invalid MAC: {mac!r}")
            continue
        out.append((mac_clean, broadcast))
    return out


def _build_magic_packet(mac: str) -> bytes:
    """Build 102-byte WoL magic packet: 6x 0xFF + 16x MAC address."""
    hex_mac = mac.replace(":", "")
    mac_bytes = bytes.fromhex(hex_mac)
    return b'\xff' * 6 + mac_bytes * 16


async def _send_wol(mac: str, broadcast: str, count: int, interval: float) -> dict:
    result = {"mac": mac, "broadcast": broadcast, "sent": False}
    try:
        packet = _build_magic_packet(mac)
        loop   = asyncio.get_running_loop()

        def _send():
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                for _ in range(count):
                    s.sendto(packet, (broadcast, 9))
                    if interval > 0:
                        import time; time.sleep(interval)

        await loop.run_in_executor(None, _send)
        result["sent"]         = True
        result["packets_sent"] = count
        logger.info(f"WoL sent to {mac} via {broadcast}")
    except Exception as e:
        result["error"] = str(e)[:150]
    return result
