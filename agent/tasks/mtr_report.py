"""
Task: run_mtr
Payload:
  target: hostname or IP e.g. "8.8.8.8"
  count: number of ping cycles (default: 10)
  resolve_names: bool (default: true)
"""

import asyncio
import logging
import json
import re

logger = logging.getLogger(__name__)

SAFE_TARGET_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')


async def run(payload: dict) -> dict:
    target = payload.get("target", "")
    if not target or not SAFE_TARGET_RE.match(target):
        raise ValueError(f"Invalid target: {target!r}")

    count         = int(payload.get("count", 10))
    resolve_names = payload.get("resolve_names", True)

    # Try JSON output first (mtr >= 0.92)
    cmd = ["mtr", "--report", "--json", "-c", str(count)]
    if not resolve_names:
        cmd.append("--no-dns")
    cmd.append(target)

    logger.info(f"Running mtr to {target} ({count} cycles)")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    mtr_timeout = count * 3 + 20  # ~1s per cycle per hop, generous margin
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=mtr_timeout)
    except asyncio.TimeoutError:
        proc.kill()
        stdout, stderr = b"", b"timeout"

    if proc.returncode == 0 and stdout:
        try:
            data = json.loads(stdout.decode())
            return _format_json_output(target, count, data)
        except json.JSONDecodeError:
            pass

    # Fall back to plain text report
    cmd_plain = ["mtr", "--report", "-c", str(count)]
    if not resolve_names:
        cmd_plain.append("--no-dns")
    cmd_plain.append(target)

    proc2 = await asyncio.create_subprocess_exec(
        *cmd_plain,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout2, stderr2 = await asyncio.wait_for(proc2.communicate(), timeout=mtr_timeout)
    except asyncio.TimeoutError:
        proc2.kill()
        raise RuntimeError(f"mtr timed out after {mtr_timeout}s")

    if proc2.returncode != 0:
        raise RuntimeError(f"mtr failed: {stderr2.decode()[:300]}")

    hops = _parse_plain(stdout2.decode())
    return {
        "target":    target,
        "cycles":    count,
        "hop_count": len(hops),
        "hops":      hops,
        "worst_loss": max((h.get("loss_pct", 0) for h in hops), default=0),
        "worst_avg_ms": max((h.get("avg_ms", 0) for h in hops if h.get("avg_ms")), default=0),
    }


def _format_json_output(target: str, count: int, data: dict) -> dict:
    report = data.get("report", {})
    hubs   = report.get("hubs", [])
    hops   = []
    for hub in hubs:
        hops.append({
            "hop":      hub.get("count"),
            "ip":       hub.get("host"),
            "hostname": hub.get("host"),
            "loss_pct": float(hub.get("Loss%", 0)),
            "sent":     hub.get("Snt", 0),
            "avg_ms":   float(hub.get("Avg", 0)),
            "best_ms":  float(hub.get("Best", 0)),
            "worst_ms": float(hub.get("Wrst", 0)),
            "stdev_ms": float(hub.get("StDev", 0)),
        })
    return {
        "target":     target,
        "cycles":     count,
        "hop_count":  len(hops),
        "hops":       hops,
        "worst_loss": max((h["loss_pct"] for h in hops), default=0),
        "worst_avg_ms": max((h["avg_ms"] for h in hops if h["avg_ms"]), default=0),
    }


def _parse_plain(output: str) -> list:
    hops = []
    for line in output.splitlines():
        # e.g.  1.|-- 192.168.1.1   0.0%    10    1.2   1.3   1.1   1.8   0.2
        m = re.match(
            r'\s*(\d+)\.\|[-?]+\s+(\S+)\s+([\d.]+)%\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)',
            line
        )
        if m:
            hops.append({
                "hop":      int(m.group(1)),
                "ip":       m.group(2),
                "hostname": m.group(2),
                "loss_pct": float(m.group(3)),
                "sent":     int(m.group(4)),
                "avg_ms":   float(m.group(6)),
                "best_ms":  float(m.group(7)),
                "worst_ms": float(m.group(8)),
                "stdev_ms": float(m.group(9)),
            })
    return hops
