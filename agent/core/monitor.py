"""
core.monitor — Background uptime and RTT monitoring loop.

Runs as a long-lived coroutine alongside the main connection loops.
Periodically pings configured monitor targets and sends results back
to the server as 'monitor_result' messages.

The server pushes a 'monitor_config' message when targets change;
the dispatcher forwards it here via update_monitor_config().
"""

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

# Shared config updated by dispatcher when server sends monitor_config
_targets: list = []
_default_interval: int = 30  # seconds
_lock: asyncio.Lock | None = None  # created lazily inside the running event loop


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


async def update_monitor_config(targets: list, interval: int = 30):
    """Called by dispatcher when server sends a monitor_config message."""
    global _targets, _default_interval
    async with _get_lock():
        _targets = targets or []
        _default_interval = interval or 30
    logger.info(f"monitor: config updated — {len(_targets)} targets, interval={_default_interval}s")


async def run_monitor(config, connection):
    """
    Main monitoring loop. Runs forever alongside the WebSocket loops.
    Exits cleanly when the connection drops (asyncio.CancelledError).
    """
    logger.info("monitor: background loop started")
    try:
        while True:
            async with _get_lock():
                targets = list(_targets)
                interval = _default_interval

            if targets:
                results = await _check_targets(targets)
                if results:
                    try:
                        await connection.send({
                            "type":    "monitor_result",
                            "results": results,
                        })
                    except Exception as e:
                        logger.debug(f"monitor: failed to send results: {e}")

            await asyncio.sleep(interval)

    except asyncio.CancelledError:
        logger.info("monitor: loop cancelled")
        raise
    except Exception as e:
        logger.error(f"monitor: unexpected error: {e}")
        # Don't crash the whole connection — just stop monitoring
        raise


async def _check_targets(targets: list) -> list:
    """Ping all targets concurrently. Returns list of result dicts."""
    sem = asyncio.Semaphore(20)

    async def check_one(target):
        async with sem:
            return await _ping(
                target.get("host") or target.get("target", ""),
                target.get("id"),
                target.get("label", ""),
            )

    results = await asyncio.gather(
        *[check_one(t) for t in targets],
        return_exceptions=True,
    )

    return [r for r in results if r and not isinstance(r, Exception)]


async def _ping(host: str, target_id=None, label: str = "") -> dict | None:
    """Single ICMP-style reachability check via TCP connect to port 80/443, fallback to raw ping."""
    if not host:
        return None

    start = time.monotonic()
    success = False
    rtt_ms = None

    # Try TCP connect to 443 first, then 80 — no root required
    for port in (443, 80):
        try:
            _, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port),
                timeout=5.0,
            )
            rtt_ms = round((time.monotonic() - start) * 1000, 1)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            success = True
            break
        except Exception:
            continue

    # Fallback: system ping (1 packet, 3s timeout)
    if not success:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ping", "-c", "1", "-W", "3", host,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode == 0:
                rtt_ms = round((time.monotonic() - start) * 1000, 1)
                success = True
        except Exception:
            pass

    return {
        "target_id":  target_id,
        "host":       host,
        "label":      label,
        "success":    success,
        "rtt_ms":     rtt_ms,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
