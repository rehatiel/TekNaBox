"""
Task: run_wireless_survey
Payload:
  interface: wireless interface e.g. "wlan0" (default: wlan0)

Scans for nearby wireless networks.
Returns SSID, BSSID, channel, frequency, signal strength, encryption type.

Scan strategy (tried in order):
  1. iw dev <iface> scan          — cleanest output, needs root or CAP_NET_ADMIN
  2. iwlist <iface> scan          — older fallback, same permission requirement
  3. wpa_cli -i <iface> scan      — triggers a fresh scan via wpa_supplicant;
                                    works on managed interfaces (Pi Zero wlan0)
  4. wpa_cli scan_results         — reads wpa_supplicant's last cached scan;
                                    no disconnect, no extra permissions needed
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)


# ── Entry point ───────────────────────────────────────────────────────────────

async def run(payload: dict) -> dict:
    interface = payload.get("interface", "wlan0")

    # Strategy 1: iw scan (preferred — richest output)
    try:
        networks, method = await _iw_scan(interface)
        return _result(interface, networks, method)
    except ScanError as e:
        logger.debug(f"iw scan failed ({e}), trying iwlist")

    # Strategy 2: iwlist scan
    try:
        networks, method = await _iwlist_scan(interface)
        return _result(interface, networks, method)
    except ScanError as e:
        logger.debug(f"iwlist scan failed ({e}), trying wpa_cli")

    # Strategy 3 & 4: wpa_supplicant path (works on managed/connected interfaces)
    try:
        networks, method = await _wpa_cli_scan(interface)
        return _result(interface, networks, method)
    except ScanError as e:
        raise RuntimeError(
            f"All scan methods failed on {interface}. "
            "If the interface is connected, try a dedicated USB WiFi adapter "
            f"as wlan1. Last error: {e}"
        )


def _result(interface: str, networks: list, method: str) -> dict:
    return {
        "interface": interface,
        "scan_method": method,
        "networks_found": len(networks),
        "networks": networks,
    }


# ── Scan backends ─────────────────────────────────────────────────────────────

class ScanError(Exception):
    pass


async def _iw_scan(interface: str):
    """iw dev <iface> scan — needs CAP_NET_ADMIN / root."""
    proc = await asyncio.create_subprocess_exec(
        "iw", "dev", interface, "scan",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        raise ScanError("iw scan timed out")
    if proc.returncode != 0:
        raise ScanError(stderr.decode(errors="replace")[:200].strip())
    networks = _parse_iw_scan(stdout.decode(errors="replace"))
    return networks, "iw"


async def _iwlist_scan(interface: str):
    """iwlist <iface> scan — older tool, same permission requirement."""
    proc = await asyncio.create_subprocess_exec(
        "iwlist", interface, "scan",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        raise ScanError("iwlist scan timed out")
    err = stderr.decode(errors="replace")
    if proc.returncode != 0 or "Interface doesn't support scanning" in err:
        raise ScanError(err[:200].strip())
    networks = _parse_iwlist(stdout.decode(errors="replace"))
    return networks, "iwlist"


async def _wpa_cli_scan(interface: str):
    """
    Use wpa_supplicant to scan without disconnecting.

    Steps:
      1. wpa_cli -i <iface> scan       — ask supplicant to do a fresh scan
      2. sleep 3s for results to arrive
      3. wpa_cli -i <iface> scan_results — read the results back

    Falls back to reading cached scan_results immediately if step 1 fails
    (e.g. wpa_supplicant isn't running but a prior scan result file exists).
    """
    # Trigger a fresh scan (best-effort — ignore failure)
    try:
        trigger = await asyncio.create_subprocess_exec(
            "wpa_cli", "-i", interface, "scan",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        trig_out, _ = await trigger.communicate()
        triggered = b"OK" in trig_out
    except FileNotFoundError:
        raise ScanError("wpa_cli not found")

    if triggered:
        # Give the supplicant time to collect beacons
        await asyncio.sleep(3)

    # Read results
    proc = await asyncio.create_subprocess_exec(
        "wpa_cli", "-i", interface, "scan_results",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
    except asyncio.TimeoutError:
        proc.kill()
        raise ScanError("wpa_cli scan_results timed out")
    if proc.returncode != 0:
        raise ScanError(stderr.decode(errors="replace")[:200].strip())

    output = stdout.decode(errors="replace")
    if "FAIL" in output or "Could not connect" in output:
        raise ScanError(f"wpa_cli scan_results: {output[:200].strip()}")

    networks = _parse_wpa_cli(output)
    method = "wpa_cli" if triggered else "wpa_cli_cached"
    return networks, method


# ── Parsers ───────────────────────────────────────────────────────────────────

def _freq_to_channel(freq_mhz: int) -> int | None:
    if 2412 <= freq_mhz <= 2484:
        return (freq_mhz - 2412) // 5 + 1
    if 5160 <= freq_mhz <= 5885:
        return (freq_mhz - 5160) // 5 + 32
    if 5955 <= freq_mhz <= 7115:
        return (freq_mhz - 5955) // 5 + 1  # 6 GHz (Wi-Fi 6E)
    return None


def _parse_iw_scan(output: str) -> list:
    networks = []
    current: dict = {}

    for line in output.splitlines():
        line = line.strip()

        if line.startswith("BSS "):
            if current:
                networks.append(current)
            bssid = line.split("BSS ")[1].split("(")[0].strip()
            current = {"bssid": bssid, "ssid": "", "channel": None,
                       "frequency_mhz": None, "signal_dbm": None,
                       "encryption": "Open"}

        elif line.startswith("SSID:"):
            current["ssid"] = line.split("SSID:")[1].strip()

        elif line.startswith("freq:"):
            try:
                freq = int(line.split(":")[1].strip())
                current["frequency_mhz"] = freq
                current["channel"] = _freq_to_channel(freq)
            except (ValueError, IndexError):
                pass

        elif re.match(r"signal:", line, re.I):
            m = re.search(r"signal:\s*([-\d.]+)", line)
            if m:
                try:
                    current["signal_dbm"] = float(m.group(1))
                except ValueError:
                    pass

        elif "WPA2" in line:
            current["encryption"] = "WPA2"
        elif "WPA" in line and current.get("encryption") != "WPA2":
            current["encryption"] = "WPA"
        elif "WEP" in line:
            current["encryption"] = "WEP"
        elif "capability:" in line.lower() and "Privacy" in line:
            if current.get("encryption") == "Open":
                current["encryption"] = "WEP/Unknown"

    if current:
        networks.append(current)

    networks.sort(key=lambda x: x.get("signal_dbm") or -999, reverse=True)
    return networks


def _parse_iwlist(output: str) -> list:
    networks = []
    current: dict = {}

    for line in output.splitlines():
        line = line.strip()

        if "Cell " in line and "Address:" in line:
            if current:
                networks.append(current)
            bssid = line.split("Address:")[1].strip()
            current = {"bssid": bssid, "ssid": "", "channel": None,
                       "frequency_mhz": None, "signal_dbm": None,
                       "encryption": "Open"}

        elif "ESSID:" in line:
            current["ssid"] = line.split("ESSID:")[1].strip().strip('"')

        elif "Channel:" in line:
            try:
                current["channel"] = int(line.split(":")[1])
            except (ValueError, IndexError):
                pass

        elif "Frequency:" in line:
            m = re.search(r"Frequency:([\d.]+)", line)
            if m:
                try:
                    freq = int(float(m.group(1)) * 1000)
                    current["frequency_mhz"] = freq
                    if not current.get("channel"):
                        current["channel"] = _freq_to_channel(freq)
                except ValueError:
                    pass

        elif "Signal level=" in line:
            m = re.search(r"Signal level=([-\d]+)", line)
            if m:
                try:
                    current["signal_dbm"] = int(m.group(1))
                except ValueError:
                    pass

        elif "Encryption key:on" in line:
            current["encryption"] = "WEP/Unknown"
        elif "IE: WPA2" in line or "WPA2" in line:
            current["encryption"] = "WPA2"
        elif "IE: WPA" in line and current.get("encryption") != "WPA2":
            current["encryption"] = "WPA"

    if current:
        networks.append(current)

    networks.sort(key=lambda x: x.get("signal_dbm") or -999, reverse=True)
    return networks


def _parse_wpa_cli(output: str) -> list:
    """
    Parse `wpa_cli scan_results` output.

    Format (tab-separated, header on first non-blank line):
        bssid / frequency / signal level / flags / ssid
        aa:bb:cc:dd:ee:ff\t2437\t-62\t[WPA2-PSK-CCMP][ESS]\tMyNetwork
    """
    networks = []

    for line in output.splitlines():
        line = line.strip()
        # Skip header and blank lines
        if not line or line.startswith("bssid") or line.startswith("Selected"):
            continue

        parts = line.split("\t")
        if len(parts) < 5:
            continue

        bssid, freq_str, signal_str, flags, ssid = (
            parts[0], parts[1], parts[2], parts[3], "\t".join(parts[4:])
        )

        # Frequency → MHz
        try:
            freq = int(freq_str)
        except ValueError:
            freq = None

        # Signal: wpa_cli reports in dBm directly
        try:
            signal = int(signal_str)
        except ValueError:
            signal = None

        # Encryption from flags field e.g. [WPA2-PSK-CCMP][ESS]
        flags_upper = flags.upper()
        if "WPA2" in flags_upper:
            enc = "WPA2"
        elif "WPA" in flags_upper:
            enc = "WPA"
        elif "WEP" in flags_upper:
            enc = "WEP"
        else:
            enc = "Open"

        networks.append({
            "bssid": bssid,
            "ssid": ssid,
            "channel": _freq_to_channel(freq) if freq else None,
            "frequency_mhz": freq,
            "signal_dbm": signal,
            "encryption": enc,
        })

    networks.sort(key=lambda x: x.get("signal_dbm") or -999, reverse=True)
    return networks
