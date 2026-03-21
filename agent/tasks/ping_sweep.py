"""
Task: run_ping_sweep
Payload:
  network: CIDR e.g. "192.168.1.0/24"
  timeout: seconds per host (default 1)
  concurrency: parallel pings (default 50)
"""

import asyncio
import ipaddress
import logging

logger = logging.getLogger(__name__)


async def _ping_host(ip: str, timeout: float, sem: asyncio.Semaphore) -> dict:
    async with sem:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ping", "-c", "1", "-W", str(int(timeout)), ip,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.communicate(), timeout=timeout + 1)
            alive = proc.returncode == 0
        except (asyncio.TimeoutError, Exception):
            alive = False
        return {"ip": ip, "alive": alive}


async def run(payload: dict) -> dict:
    network_str = payload.get("network", "")
    if not network_str:
        raise ValueError("No network specified")

    try:
        network = ipaddress.ip_network(network_str, strict=False)
    except ValueError as e:
        raise ValueError(f"Invalid network: {e}")

    hosts = list(network.hosts())
    if len(hosts) > 1024:
        raise ValueError(f"Network too large ({len(hosts)} hosts, max 1024)")

    timeout = float(payload.get("timeout", 1.0))
    concurrency = int(payload.get("concurrency", 50))

    logger.info(f"Ping sweep: {network_str} ({len(hosts)} hosts)")

    sem = asyncio.Semaphore(concurrency)
    tasks = [_ping_host(str(ip), timeout, sem) for ip in hosts]
    results = await asyncio.gather(*tasks)

    alive = [r["ip"] for r in results if r["alive"]]
    logger.info(f"Ping sweep complete: {len(alive)}/{len(hosts)} hosts up")

    return {
        "network": network_str,
        "hosts_checked": len(hosts),
        "hosts_up": len(alive),
        "alive_hosts": alive,
    }
