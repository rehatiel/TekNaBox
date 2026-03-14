"""
Task: run_traceroute
Payload:
  target: hostname or IP e.g. "8.8.8.8"
  max_hops: integer (default: 30)
  protocol: "icmp" | "udp" | "tcp" (default: icmp)
  resolve_names: bool (default: true)
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_TARGET_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')


async def run(payload: dict) -> dict:
    target = payload.get("target", "")
    if not target or not SAFE_TARGET_RE.match(target):
        raise ValueError(f"Invalid target: {target!r}")

    max_hops      = int(payload.get("max_hops", 30))
    protocol      = payload.get("protocol", "icmp")
    resolve_names = payload.get("resolve_names", True)

    cmd = ["traceroute", "-m", str(max_hops)]

    if not resolve_names:
        cmd.append("-n")

    if protocol == "tcp":
        cmd += ["-T"]
    elif protocol == "udp":
        pass  # default
    else:
        cmd += ["-I"]  # ICMP

    cmd.append(target)

    logger.info(f"Running traceroute to {target}")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timeout = max_hops * 3 + 15   # 3s per hop worst case + margin
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"traceroute timed out after {timeout}s")

    output = stdout.decode()
    hops   = _parse_traceroute(output)

    return {
        "target":    target,
        "protocol":  protocol,
        "max_hops":  max_hops,
        "hop_count": len([h for h in hops if h.get("ip")]),
        "hops":      hops,
        "raw":       output[:3000],
    }


def _parse_traceroute(output: str) -> list:
    hops = []
    for line in output.splitlines():
        line = line.strip()
        # e.g.  1  192.168.1.1 (192.168.1.1)  1.234 ms  1.456 ms  1.678 ms
        #        2  * * *
        m = re.match(r'^(\d+)\s+(.+)$', line)
        if not m:
            continue

        hop_num = int(m.group(1))
        rest    = m.group(2).strip()

        if rest.startswith("* * *") or rest == "*":
            hops.append({"hop": hop_num, "ip": None, "hostname": None, "rtt_ms": []})
            continue

        # Extract IP
        ip_match       = re.search(r'\(?([\d.]+)\)?', rest)
        hostname_match = re.search(r'^([\w.\-]+)\s+\(', rest)
        rtt_matches    = re.findall(r'([\d.]+)\s+ms', rest)

        hops.append({
            "hop":      hop_num,
            "ip":       ip_match.group(1) if ip_match else None,
            "hostname": hostname_match.group(1) if hostname_match else None,
            "rtt_ms":   [float(r) for r in rtt_matches],
            "avg_rtt":  round(sum(float(r) for r in rtt_matches) / len(rtt_matches), 2) if rtt_matches else None,
        })

    return hops
