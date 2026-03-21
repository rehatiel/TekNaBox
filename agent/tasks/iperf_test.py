"""
Task: run_iperf
Payload:
  server: iperf3 server IP/hostname (required)
  port: server port (default: 5201)
  duration: test duration in seconds (default: 10)
  protocol: "tcp" | "udp" (default: tcp)
  reverse: bool — test download instead of upload (default: false)
  parallel: number of parallel streams (default: 1)
"""

import asyncio
import logging
import json
import re

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')


async def run(payload: dict) -> dict:
    server = payload.get("server", "")
    if not server or not SAFE_HOST_RE.match(server):
        raise ValueError(f"Invalid server: {server!r}")

    port     = int(payload.get("port", 5201))
    duration = int(payload.get("duration", 10))
    protocol = payload.get("protocol", "tcp")
    reverse  = payload.get("reverse", False)
    parallel = int(payload.get("parallel", 1))

    cmd = [
        "iperf3",
        "-c", server,
        "-p", str(port),
        "-t", str(duration),
        "-P", str(parallel),
        "-J",  # JSON output
    ]

    if protocol == "udp":
        cmd.append("-u")
    if reverse:
        cmd.append("-R")

    logger.info(f"Running iperf3 to {server}:{port} ({protocol}, {duration}s)")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=duration + 30)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError("iperf3 timed out")

    if proc.returncode != 0:
        err = stderr.decode()[:300]
        raise RuntimeError(f"iperf3 failed: {err}")

    try:
        data = json.loads(stdout.decode())
    except json.JSONDecodeError:
        raise RuntimeError("iperf3 returned invalid JSON")

    return _parse_result(data, protocol, reverse)


def _parse_result(data: dict, protocol: str, reverse: bool) -> dict:
    end     = data.get("end", {})
    streams = data.get("intervals", [])

    if protocol == "tcp":
        sent     = end.get("sum_sent", {})
        received = end.get("sum_received", {})
        return {
            "protocol":          "tcp",
            "direction":         "download" if reverse else "upload",
            "duration_s":        round(sent.get("seconds", 0), 2),
            "bytes_sent":        sent.get("bytes", 0),
            "bytes_received":    received.get("bytes", 0),
            "mbps_sent":         round(sent.get("bits_per_second", 0) / 1e6, 2),
            "mbps_received":     round(received.get("bits_per_second", 0) / 1e6, 2),
            "retransmits":       sent.get("retransmits", 0),
            "cpu_sender_pct":    round(end.get("cpu_utilization_percent", {}).get("host_total", 0), 1),
            "cpu_receiver_pct":  round(end.get("cpu_utilization_percent", {}).get("remote_total", 0), 1),
        }
    else:
        udp_sum = end.get("sum", {})
        return {
            "protocol":       "udp",
            "direction":      "download" if reverse else "upload",
            "duration_s":     round(udp_sum.get("seconds", 0), 2),
            "mbps":           round(udp_sum.get("bits_per_second", 0) / 1e6, 2),
            "jitter_ms":      round(udp_sum.get("jitter_ms", 0), 3),
            "packets_sent":   udp_sum.get("packets", 0),
            "packets_lost":   udp_sum.get("lost_packets", 0),
            "loss_pct":       round(udp_sum.get("lost_percent", 0), 2),
        }
