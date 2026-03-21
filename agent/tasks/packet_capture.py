"""
Task: run_packet_capture
Payload:
  interface: network interface (default: eth0)
  duration: capture duration in seconds (default: 10, max: 60)
  filter: BPF filter string e.g. "tcp port 80" (default: none)
  max_packets: max packets to capture (default: 500)
  mode: "summary" | "protocols" | "conversations" (default: summary)

Requires tshark (wireshark-common package).

Design: all modes capture to a single temp pcap file, then run
post-capture -z statistics against it — avoids running N separate
tshark processes for summary mode (which was 3 × duration seconds).
"""

import asyncio
import logging
import os
import re
import tempfile

logger = logging.getLogger(__name__)

SAFE_IFACE_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')
MAX_DURATION  = 60
MAX_PACKETS   = 1000


async def run(payload: dict) -> dict:
    interface   = payload.get("interface", "eth0")
    duration    = min(int(payload.get("duration", 10)), MAX_DURATION)
    bpf_filter  = payload.get("filter", "")
    max_packets = min(int(payload.get("max_packets", 500)), MAX_PACKETS)
    mode        = payload.get("mode", "summary")

    if not SAFE_IFACE_RE.match(interface):
        raise ValueError(f"Invalid interface: {interface!r}")
    if bpf_filter and not re.match(r'^[a-zA-Z0-9 .\-_/!&|()]+$', bpf_filter):
        raise ValueError(f"Invalid BPF filter: {bpf_filter!r}")

    results = {
        "interface": interface,
        "duration_s": duration,
        "filter": bpf_filter or "none",
    }

    # ── Step 1: single capture to temp pcap ──────────────────────────────────
    with tempfile.NamedTemporaryFile(suffix=".pcap", delete=False) as f:
        pcap_path = f.name

    try:
        capture_cmd = [
            "tshark", "-i", interface,
            "-a", f"duration:{duration}",
            "-c", str(max_packets),
            "-w", pcap_path,
            "-q",
        ]
        if bpf_filter:
            capture_cmd += ["-f", bpf_filter]

        out, err = await _run(capture_cmd, duration + 15)

        # Packet count from stderr ("N packets captured")
        m = re.search(r'(\d+) packets? captured', err + out)
        results["packet_count"] = int(m.group(1)) if m else 0

        if not os.path.exists(pcap_path) or os.path.getsize(pcap_path) < 24:
            results["error"] = "No packets captured (empty pcap)"
            return results

        # ── Step 2: post-process stats against the saved pcap ─────────────────
        stat_tasks = []
        if mode in ("summary", "protocols"):
            stat_tasks.append(_read_protocol_stats(pcap_path))
        if mode in ("summary", "conversations"):
            stat_tasks.append(_read_conversations(pcap_path))

        stat_results = await asyncio.gather(*stat_tasks, return_exceptions=True)

        idx = 0
        if mode in ("summary", "protocols"):
            r = stat_results[idx]; idx += 1
            results["protocol_breakdown"] = r if not isinstance(r, Exception) else {}

        if mode in ("summary", "conversations"):
            r = stat_results[idx]
            results["top_conversations"] = r if not isinstance(r, Exception) else []

    finally:
        try:
            os.unlink(pcap_path)
        except Exception:
            pass

    return results


async def _read_protocol_stats(pcap: str) -> dict:
    out, _ = await _run(["tshark", "-r", pcap, "-q", "-z", "io,phs"], 30)
    return _parse_protocol_hierarchy(out)


async def _read_conversations(pcap: str) -> list:
    out, _ = await _run(["tshark", "-r", pcap, "-q", "-z", "conv,ip"], 30)
    return _parse_conversations(out)


async def _run(cmd: list, timeout: int) -> tuple[str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return stdout.decode(errors="replace"), stderr.decode(errors="replace")
    except asyncio.TimeoutError:
        return "", "timeout"
    except Exception as e:
        return "", str(e)


def _parse_protocol_hierarchy(output: str) -> dict:
    protocols = {}
    for line in output.splitlines():
        m = re.match(r'\s+([\w.]+)\s+frames:(\d+)\s+bytes:(\d+)', line)
        if m:
            protocols[m.group(1)] = {
                "frames": int(m.group(2)),
                "bytes":  int(m.group(3)),
            }
    return protocols


def _parse_conversations(output: str) -> list:
    convs = []
    in_section = False
    for line in output.splitlines():
        if "IPv4 Conversations" in line or "IP Conversations" in line:
            in_section = True
            continue
        if in_section:
            m = re.match(
                r'\s*([\d.]+)\s+<->\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)',
                line
            )
            if m:
                convs.append({
                    "src":         m.group(1),
                    "dst":         m.group(2),
                    "frames_a_b":  int(m.group(3)),
                    "bytes_a_b":   int(m.group(4)),
                    "frames_b_a":  int(m.group(5)),
                    "bytes_b_a":   int(m.group(6)),
                    "total_bytes": int(m.group(4)) + int(m.group(6)),
                })
            elif line.strip() == "" and convs:
                break
    convs.sort(key=lambda x: x["total_bytes"], reverse=True)
    return convs[:20]
