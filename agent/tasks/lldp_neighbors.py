"""
Task: run_lldp_neighbors
Payload:
  interface: network interface to listen on (default: eth0)
  duration: seconds to listen for LLDP frames (default: 35)
            LLDP frames are sent every 30s by default on most gear

Passively captures LLDP (802.1AB) and CDP (Cisco Discovery Protocol)
frames to build a picture of directly-connected network infrastructure.
Reveals switch/AP make, model, firmware, port, VLAN, and capabilities.

Requires: tcpdump (passive capture, read-only)
"""

import asyncio
import logging
import re
import struct
import tempfile
import os

logger = logging.getLogger(__name__)

SAFE_IFACE_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')

# LLDP EtherType
LLDP_ETHERTYPE  = 0x88CC
# CDP uses SNAP encapsulation on multicast 01:00:0C:CC:CC:CC
CDP_MULTICAST   = "01:00:0c:cc:cc:cc"


async def run(payload: dict) -> dict:
    interface = str(payload.get("interface", "eth0")).strip()
    duration  = int(payload.get("duration", 35))

    if not SAFE_IFACE_RE.match(interface):
        raise ValueError(f"Invalid interface: {interface!r}")

    duration = max(10, min(duration, 120))

    logger.info(f"Listening for LLDP/CDP on {interface} for {duration}s")

    # Capture to pcap file then parse
    with tempfile.NamedTemporaryFile(suffix=".pcap", delete=False) as f:
        pcap_path = f.name

    try:
        # Capture LLDP (0x88cc) and CDP (01:00:0c:cc:cc:cc) frames
        proc = await asyncio.create_subprocess_exec(
            "tcpdump", "-i", interface,
            "-w", pcap_path,
            "-G", str(duration),
            "-W", "1",
            "ether proto 0x88cc or ether dst 01:00:0c:cc:cc:cc",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=duration + 10)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()

        # Parse the pcap
        neighbors = await asyncio.get_running_loop().run_in_executor(
            None, _parse_pcap, pcap_path
        )

    finally:
        try:
            os.unlink(pcap_path)
        except Exception:
            pass

    if not neighbors:
        # Try reading lldpctl output if lldpd is running
        neighbors = await _try_lldpctl()

    return {
        "interface":       interface,
        "duration_s":      duration,
        "neighbors_found": len(neighbors),
        "neighbors":       neighbors,
    }


def _parse_pcap(path: str) -> list:
    """Parse LLDP/CDP frames from pcap file."""
    neighbors = {}  # keyed by chassis_id to deduplicate

    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception:
        return []

    # Parse pcap global header
    if len(data) < 24:
        return []

    magic = struct.unpack_from("I", data, 0)[0]
    if magic not in (0xa1b2c3d4, 0xd4c3b2a1):
        return []

    be = magic == 0xa1b2c3d4
    endian = ">" if be else "<"

    offset = 24  # skip global header
    while offset + 16 <= len(data):
        # Packet header
        ts_sec, ts_usec, incl_len, orig_len = struct.unpack_from(
            f"{endian}IIII", data, offset
        )
        offset += 16
        if offset + incl_len > len(data):
            break

        frame = data[offset:offset + incl_len]
        offset += incl_len

        nb = _try_parse_lldp(frame) or _try_parse_cdp(frame)
        if nb:
            key = nb.get("chassis_id") or nb.get("device_id") or str(len(neighbors))
            if key not in neighbors:
                neighbors[key] = nb

    return list(neighbors.values())


def _try_parse_lldp(frame: bytes) -> dict | None:
    """Parse an LLDP frame (Ethernet II, EtherType 0x88CC)."""
    if len(frame) < 14:
        return None
    # Check EtherType
    ethertype = struct.unpack_from("!H", frame, 12)[0]
    if ethertype != LLDP_ETHERTYPE:
        return None

    nb     = {"protocol": "LLDP", "capabilities": []}
    offset = 14  # skip Ethernet header

    while offset + 2 <= len(frame):
        header = struct.unpack_from("!H", frame, offset)[0]
        tlv_type   = (header >> 9) & 0x7F
        tlv_length = header & 0x1FF
        offset += 2

        if tlv_type == 0:  # End of LLDPDU
            break
        if offset + tlv_length > len(frame):
            break

        value = frame[offset:offset + tlv_length]
        offset += tlv_length

        if tlv_type == 1:  # Chassis ID
            nb["chassis_id"] = _decode_lldp_id(value)
        elif tlv_type == 2:  # Port ID
            nb["port_id"] = _decode_lldp_id(value)
        elif tlv_type == 3:  # TTL
            if len(value) >= 2:
                nb["ttl"] = struct.unpack("!H", value)[0]
        elif tlv_type == 4:  # Port Description
            nb["port_description"] = value.decode("utf-8", errors="replace").strip()
        elif tlv_type == 5:  # System Name
            nb["system_name"] = value.decode("utf-8", errors="replace").strip()
        elif tlv_type == 6:  # System Description
            nb["system_description"] = value.decode("utf-8", errors="replace").strip()[:200]
        elif tlv_type == 7:  # System Capabilities
            if len(value) >= 4:
                caps, enabled = struct.unpack("!HH", value[:4])
                nb["capabilities"] = _decode_capabilities(enabled)
        elif tlv_type == 8:  # Management Address
            nb["mgmt_address"] = _decode_mgmt_addr(value)

    return nb if nb.get("chassis_id") or nb.get("system_name") else None


def _decode_lldp_id(value: bytes) -> str:
    if not value:
        return ""
    subtype = value[0]
    data    = value[1:]
    if subtype in (3, 5, 6, 7):  # MAC, network addr, interface, local
        if subtype == 3 and len(data) == 6:
            return ":".join(f"{b:02X}" for b in data)
        try:
            return data.decode("utf-8", errors="replace").strip()
        except Exception:
            return data.hex()
    try:
        return data.decode("utf-8", errors="replace").strip()
    except Exception:
        return data.hex()


def _decode_capabilities(bits: int) -> list:
    CAP_NAMES = {
        0x01: "Other", 0x02: "Repeater", 0x04: "Bridge",
        0x08: "WLAN AP", 0x10: "Router", 0x20: "Phone",
        0x40: "DOCSIS Cable", 0x80: "Station",
    }
    return [name for bit, name in CAP_NAMES.items() if bits & bit]


def _decode_mgmt_addr(value: bytes) -> str | None:
    if len(value) < 2:
        return None
    addr_len    = value[0]
    addr_subtype = value[1]
    addr_data   = value[2:2 + addr_len - 1]
    if addr_subtype == 1 and len(addr_data) == 4:  # IPv4
        return ".".join(str(b) for b in addr_data)
    return addr_data.hex()


def _try_parse_cdp(frame: bytes) -> dict | None:
    """Very basic CDP frame detection and parsing."""
    if len(frame) < 22:
        return None
    # CDP uses LLC SNAP: dst=01:00:0c:cc:cc:cc
    dst = ":".join(f"{b:02x}" for b in frame[:6])
    if dst != CDP_MULTICAST:
        return None

    nb = {"protocol": "CDP"}
    # Skip to CDP payload (after Ethernet + 802.3 LLC + SNAP = 22 bytes)
    offset = 22
    # Skip CDP header (version 1 byte, TTL 1 byte, checksum 2 bytes)
    offset += 4
    if offset >= len(frame):
        return nb

    while offset + 4 <= len(frame):
        tlv_type   = struct.unpack_from("!H", frame, offset)[0]
        tlv_length = struct.unpack_from("!H", frame, offset + 2)[0]
        if tlv_length < 4:
            break
        value  = frame[offset + 4:offset + tlv_length]
        offset += tlv_length

        try:
            if tlv_type == 0x0001:
                nb["device_id"] = value.decode("utf-8", errors="replace").strip()
            elif tlv_type == 0x0003:
                nb["port_id"] = value.decode("utf-8", errors="replace").strip()
            elif tlv_type == 0x0005:
                nb["system_description"] = value.decode("utf-8", errors="replace").strip()[:200]
            elif tlv_type == 0x0006:
                nb["platform"] = value.decode("utf-8", errors="replace").strip()
            elif tlv_type == 0x0016:
                nb["system_name"] = value.decode("utf-8", errors="replace").strip()
        except Exception:
            pass

    return nb if nb.get("device_id") or nb.get("system_name") else None


async def _try_lldpctl() -> list:
    """If lldpd is running, use lldpctl for richer output."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "lldpctl", "-f", "keyvalue",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        return _parse_lldpctl(stdout.decode(errors="replace"))
    except Exception:
        return []


def _parse_lldpctl(output: str) -> list:
    """Parse lldpctl -f keyvalue output."""
    neighbors = {}
    for line in output.splitlines():
        m = re.match(r'lldp\.([\w.]+)\.(.+?)=(.+)', line)
        if not m:
            continue
        iface, key, value = m.groups()
        if iface not in neighbors:
            neighbors[iface] = {"protocol": "LLDP (lldpd)", "local_interface": iface}
        key_map = {
            "chassis.name":      "system_name",
            "chassis.descr":     "system_description",
            "chassis.mac":       "chassis_id",
            "chassis.mgmt.ip":   "mgmt_address",
            "port.ifname":       "port_id",
            "port.descr":        "port_description",
        }
        if key in key_map:
            neighbors[iface][key_map[key]] = value.strip()
    return list(neighbors.values())
