"""
Task: run_port_scan
A fast async TCP connect scan — does not require nmap or root.
Payload:
  target: single IP or hostname
  ports: list of ints or "start-end" range string
  timeout: per-port timeout in seconds (default 1)
  concurrency: max simultaneous connections (default 100)
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)


def _parse_ports(ports_input) -> list:
    if isinstance(ports_input, list):
        return [int(p) for p in ports_input]
    s = str(ports_input)
    if "-" in s and re.match(r'^\d+-\d+$', s):
        start, end = s.split("-")
        return list(range(int(start), int(end) + 1))
    if "," in s:
        return [int(p.strip()) for p in s.split(",")]
    return [int(s)]


async def _check_port(host: str, port: int, timeout: float, sem: asyncio.Semaphore) -> dict:
    async with sem:
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=timeout,
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return {"port": port, "open": True}
        except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
            return {"port": port, "open": False}


async def run(payload: dict) -> dict:
    target = str(payload.get("target", "")).strip()
    if not target:
        raise ValueError("No target specified")

    ports = _parse_ports(payload.get("ports", "1-1024"))
    timeout = float(payload.get("timeout", 1.0))
    concurrency = int(payload.get("concurrency", 100))

    if len(ports) > 65535:
        raise ValueError("Too many ports requested")

    logger.info(f"Port scan: {target}, {len(ports)} ports, concurrency={concurrency}")

    sem = asyncio.Semaphore(concurrency)
    tasks = [_check_port(target, p, timeout, sem) for p in ports]
    results = await asyncio.gather(*tasks)

    open_ports = [r["port"] for r in results if r["open"]]
    logger.info(f"Port scan complete: {len(open_ports)} open ports on {target}")

    return {
        "target": target,
        "ports_scanned": len(ports),
        "open_ports": open_ports,
        "open_count": len(open_ports),
    }
