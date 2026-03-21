"""
Task: run_arp_scan
Payload:
  interface: network interface e.g. "eth0" or "wlan0" (default: auto)
  targets: CIDR or IP range e.g. "192.168.1.0/24" (default: local subnet)

Uses arp-scan to discover hosts on the LAN with MAC addresses and vendor info.
Requires root (runs via sudo).
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)


async def run(payload: dict) -> dict:
    interface = payload.get("interface", "")
    targets   = payload.get("targets", "--localnet")

    cmd = ["arp-scan"]
    if interface:
        cmd += ["--interface", interface]
    if targets == "--localnet" or not targets:
        cmd.append("--localnet")
    else:
        # Validate target is a safe CIDR/IP
        if not re.match(r'^[\d./]+$', str(targets)):
            raise ValueError(f"Invalid target: {targets!r}")
        cmd.append(targets)

    logger.info(f"Running arp-scan: {' '.join(cmd)}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("arp-scan timed out after 60s")

    if proc.returncode != 0:
        raise RuntimeError(f"arp-scan failed: {stderr.decode()[:300]}")

    return _parse_output(stdout.decode())


def _parse_output(output: str) -> dict:
    hosts = []
    for line in output.splitlines():
        # Lines look like: 192.168.1.1\t00:11:22:33:44:55\tCisco Systems
        parts = line.strip().split("\t")
        if len(parts) >= 2 and re.match(r'^\d+\.\d+\.\d+\.\d+$', parts[0]):
            hosts.append({
                "ip":     parts[0],
                "mac":    parts[1] if len(parts) > 1 else "",
                "vendor": parts[2] if len(parts) > 2 else "",
            })

    # Summary line: "X hosts responded"
    summary_match = re.search(r'(\d+) hosts? responded', output)
    hosts_responded = int(summary_match.group(1)) if summary_match else len(hosts)

    return {
        "hosts_found": hosts_responded,
        "hosts": hosts,
    }
