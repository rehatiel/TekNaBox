"""
Task: run_dns_lookup
Payload:
  target: domain or IP to query e.g. "example.com" or "8.8.8.8"
  record_types: list of record types e.g. ["A","MX","TXT","NS","PTR"] (default: all)
  nameserver: optional DNS server to query e.g. "8.8.8.8"
  zone_transfer: bool — attempt AXFR zone transfer (default: false)
"""

import asyncio
import logging
import re
import shlex

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')
DEFAULT_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "SOA", "CNAME"]


async def run(payload: dict) -> dict:
    target = payload.get("target", "")
    if not target or not SAFE_HOST_RE.match(target):
        raise ValueError(f"Invalid target: {target!r}")

    record_types = payload.get("record_types", DEFAULT_TYPES)
    nameserver   = payload.get("nameserver", "")
    zone_xfer    = payload.get("zone_transfer", False)

    if nameserver and not re.match(r'^[\d.]+$', nameserver):
        raise ValueError(f"Invalid nameserver: {nameserver!r}")

    results = {}
    errors  = {}

    for rtype in record_types:
        rtype = rtype.upper()
        cmd = ["dig", "+noall", "+answer", "+ttlid", rtype, target]
        if nameserver:
            cmd.append(f"@{nameserver}")

        out, err = await _run_cmd(cmd)
        records = _parse_dig(out, rtype)
        if records:
            results[rtype] = records
        elif err:
            errors[rtype] = err.strip()[:200]

    # Reverse lookup if target is an IP
    if re.match(r'^\d+\.\d+\.\d+\.\d+$', target):
        cmd = ["dig", "+noall", "+answer", "-x", target]
        if nameserver:
            cmd.append(f"@{nameserver}")
        out, _ = await _run_cmd(cmd)
        ptr = _parse_dig(out, "PTR")
        if ptr:
            results["PTR"] = ptr

    # Zone transfer attempt
    zone_transfer_result = None
    if zone_xfer:
        ns_records = results.get("NS", [])
        ns_host = ns_records[0].get("value", "").rstrip(".") if ns_records else target
        cmd = ["dig", "AXFR", target, f"@{ns_host}"]
        out, err = await _run_cmd(cmd, timeout=15)
        zone_transfer_result = {
            "attempted": True,
            "nameserver": ns_host,
            "success": "Transfer failed" not in out and len(out) > 100,
            "output": out[:3000] if out else err[:500],
        }

    return {
        "target":        target,
        "nameserver":    nameserver or "system default",
        "records":       results,
        "errors":        errors,
        "zone_transfer": zone_transfer_result,
    }


async def _run_cmd(cmd: list, timeout: int = 10) -> tuple:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return stdout.decode(), stderr.decode()
    except asyncio.TimeoutError:
        return "", "timeout"
    except Exception as e:
        return "", str(e)


def _parse_dig(output: str, rtype: str) -> list:
    records = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        records.append({
            "name":  parts[0].rstrip("."),
            "ttl":   parts[1],
            "class": parts[2],
            "type":  parts[3],
            "value": " ".join(parts[4:]).rstrip("."),
        })
    return records
