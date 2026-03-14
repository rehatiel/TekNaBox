"""
core.net_watcher — Background network presence monitor.

Like Fing: continuously scans the local network via ARP, detects when devices
join or leave, and reports events to the server as 'network_event' messages.

Events sent to server:
  { "type": "network_event", "event": "device_joined",  "device": {...} }
  { "type": "network_event", "event": "device_left",    "device": {...} }
  { "type": "network_event", "event": "device_updated", "device": {...} }  # IP changed

State is persisted to disk so rejoins after an agent restart are tracked.

Configured via 'net_watch_config' message from the server:
  {
    "type":                "net_watch_config",
    "enabled":             true,
    "subnet":              "192.168.1.0/24",   // or "" for --localnet
    "interface":           "eth0",             // or "" for auto
    "interval":            60,                 // seconds between scans
    "departure_threshold": 3                   // missed scans before declaring left
  }
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionManager

logger = logging.getLogger(__name__)

STATE_FILE = "/etc/msp-agent/network_state.json"

# Global configuration — updated by update_net_watch_config()
_config: dict = {
    "enabled":             False,
    "subnet":              "",
    "interface":           "",
    "interval":            60,
    "departure_threshold": 3,
}
_config_lock: asyncio.Lock | None = None

# In-memory device registry: mac → device dict
_devices:    dict[str, dict] = {}
# Consecutive missed scan counter per MAC
_miss_count: dict[str, int]  = {}


def _get_lock() -> asyncio.Lock:
    global _config_lock
    if _config_lock is None:
        _config_lock = asyncio.Lock()
    return _config_lock


async def update_net_watch_config(cfg: dict):
    """Called by dispatcher when server sends a net_watch_config message."""
    global _config
    allowed = {"enabled", "subnet", "interface", "interval", "departure_threshold"}
    async with _get_lock():
        for k, v in cfg.items():
            if k in allowed:
                _config[k] = v
    logger.info(f"net_watcher: config updated enabled={_config['enabled']} "
                f"subnet={_config['subnet']!r} interval={_config['interval']}s")


async def run_net_watcher(connection: "ConnectionManager"):
    """
    Main loop. Runs alongside run_monitor inside _connect_and_run().
    Exits cleanly on asyncio.CancelledError.
    """
    _load_state()
    logger.info("net_watcher: loop started")
    try:
        while True:
            async with _get_lock():
                cfg = dict(_config)

            if not cfg["enabled"]:
                await asyncio.sleep(10)
                continue

            try:
                await _scan_and_report(cfg, connection)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"net_watcher: scan error: {e}")

            await asyncio.sleep(cfg["interval"])

    except asyncio.CancelledError:
        logger.info("net_watcher: loop cancelled")
        raise


async def _scan_and_report(cfg: dict, connection: "ConnectionManager"):
    hosts     = await _arp_scan(cfg["interface"], cfg["subnet"])
    now       = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    seen_macs = set()

    for host in hosts:
        mac    = host.get("mac", "").upper()
        ip     = host.get("ip", "")
        vendor = host.get("vendor", "")

        if not mac or not ip:
            continue

        seen_macs.add(mac)
        _miss_count[mac] = 0  # reset departure counter

        if mac not in _devices:
            _devices[mac] = {
                "mac":        mac,
                "ip":         ip,
                "vendor":     vendor,
                "first_seen": now,
                "last_seen":  now,
            }
            await _send_event(connection, "device_joined", _devices[mac])
        else:
            existing = _devices[mac]
            existing["last_seen"] = now
            if existing["ip"] != ip:
                existing["ip"] = ip
                await _send_event(connection, "device_updated", existing)

    # Check for departed devices
    threshold = int(cfg["departure_threshold"])
    for mac in list(_devices.keys()):
        if mac not in seen_macs:
            _miss_count[mac] = _miss_count.get(mac, 0) + 1
            if _miss_count[mac] >= threshold:
                device = _devices.pop(mac, None)
                _miss_count.pop(mac, None)
                if device:
                    device["last_seen"] = now
                    await _send_event(connection, "device_left", device)

    _save_state()


async def _send_event(connection: "ConnectionManager", event: str, device: dict):
    try:
        await connection.send({
            "type":   "network_event",
            "event":  event,
            "device": dict(device),
        })
        logger.info(f"net_watcher: {event} ip={device.get('ip')} mac={device.get('mac')}")
    except Exception as e:
        logger.debug(f"net_watcher: send failed: {e}")


async def _arp_scan(interface: str, subnet: str) -> list[dict]:
    cmd = ["arp-scan"]
    if interface:
        cmd += ["--interface", interface]
    if not subnet:
        cmd.append("--localnet")
    else:
        if not re.match(r'^[\d./]+$', str(subnet)):
            logger.warning(f"net_watcher: invalid subnet {subnet!r}, using --localnet")
            cmd.append("--localnet")
        else:
            cmd.append(subnet)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    except Exception as e:
        logger.warning(f"net_watcher: arp-scan error: {e}")
        return []

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


def _load_state():
    global _devices, _miss_count
    try:
        with open(STATE_FILE) as f:
            data = json.load(f)
        _devices    = data.get("devices", {})
        _miss_count = {}
        logger.info(f"net_watcher: restored {len(_devices)} devices from state file")
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.warning(f"net_watcher: could not load state: {e}")


def _save_state():
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as f:
            json.dump({"devices": _devices}, f, indent=2)
    except Exception as e:
        logger.debug(f"net_watcher: could not save state: {e}")
