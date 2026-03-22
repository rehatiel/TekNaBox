"""
core.monitor — Background uptime monitoring loop.

Supports ping, TCP, HTTP, and DNS checks.
Each monitor runs on its own interval. Results are sent immediately
after each check as 'monitor_result' messages.
"""

import asyncio
import logging
import re
import socket
import ssl
import time
from typing import Optional

logger = logging.getLogger(__name__)

_monitors: list = []
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


async def update_monitor_config(monitors: list) -> None:
    """Called by dispatcher when server sends a monitor_config message."""
    global _monitors
    async with _get_lock():
        _monitors = list(monitors or [])
    logger.info(f"monitor: config updated — {len(_monitors)} monitors")


async def run_monitor(config, connection) -> None:
    """
    Main monitoring loop. Runs forever alongside the WebSocket loops.
    Checks each monitor when its interval is due, sends results immediately.
    """
    logger.info("monitor: loop started")
    last_run: dict[str, float] = {}  # monitor_id → monotonic timestamp

    try:
        while True:
            async with _get_lock():
                monitors = list(_monitors)

            now = time.monotonic()
            due = [
                m for m in monitors
                if now - last_run.get(m["id"], 0) >= m.get("interval", 60)
            ]

            if due:
                # Run all due checks concurrently (max 10 at once)
                sem = asyncio.Semaphore(10)

                async def bounded_check(mon):
                    async with sem:
                        return await _check(mon)

                results = await asyncio.gather(
                    *[bounded_check(m) for m in due],
                    return_exceptions=True,
                )

                for mon, result in zip(due, results):
                    last_run[mon["id"]] = time.monotonic()
                    if result and not isinstance(result, Exception):
                        try:
                            await connection.send({
                                "type":    "monitor_result",
                                "results": [result],
                            })
                        except Exception as e:
                            logger.debug(f"monitor: send failed: {e}")
                    elif isinstance(result, Exception):
                        logger.debug(f"monitor: check error for {mon.get('id')}: {result}")

            await asyncio.sleep(5)  # Poll for due monitors every 5s

    except asyncio.CancelledError:
        logger.info("monitor: loop cancelled")
        raise
    except Exception as e:
        logger.error(f"monitor: unexpected error: {e}")
        raise


async def _check(monitor: dict) -> Optional[dict]:
    """Dispatch to the appropriate check function."""
    mon_type = monitor.get("type", "ping")
    try:
        if mon_type == "ping":
            return await _check_ping(monitor)
        elif mon_type == "tcp":
            return await _check_tcp(monitor)
        elif mon_type == "http":
            return await _check_http(monitor)
        elif mon_type == "dns":
            return await _check_dns(monitor)
        else:
            return _fail(monitor, f"unknown monitor type: {mon_type}")
    except Exception as e:
        return _fail(monitor, str(e))


# ── Ping ──────────────────────────────────────────────────────────────────────

async def _check_ping(monitor: dict) -> dict:
    host    = monitor["target"]
    timeout = monitor.get("timeout", 10)
    start   = time.monotonic()

    try:
        proc = await asyncio.create_subprocess_exec(
            "ping", "-c", "1", "-W", str(max(1, timeout)), host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 2)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return _fail(monitor, "ping timeout")

        rtt_ms = None
        if proc.returncode == 0:
            m = re.search(r"time=([\d.]+)", stdout.decode())
            rtt_ms = float(m.group(1)) if m else round((time.monotonic() - start) * 1000, 1)

        return {
            "monitor_id": monitor["id"],
            "success":    proc.returncode == 0,
            "rtt_ms":     rtt_ms,
            "error":      None if proc.returncode == 0 else "host unreachable",
            "checked_at": _now(),
        }
    except Exception as e:
        return _fail(monitor, str(e))


# ── TCP ───────────────────────────────────────────────────────────────────────

async def _check_tcp(monitor: dict) -> dict:
    host    = monitor["target"]
    port    = monitor.get("port", 80)
    timeout = monitor.get("timeout", 10)
    start   = time.monotonic()

    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        rtt_ms = round((time.monotonic() - start) * 1000, 1)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return {"monitor_id": monitor["id"], "success": True, "rtt_ms": rtt_ms, "error": None, "checked_at": _now()}
    except asyncio.TimeoutError:
        return _fail(monitor, f"TCP timeout on port {port}")
    except ConnectionRefusedError:
        return _fail(monitor, f"port {port} refused")
    except Exception as e:
        return _fail(monitor, str(e))


# ── HTTP ──────────────────────────────────────────────────────────────────────

async def _check_http(monitor: dict) -> dict:
    import urllib.request
    import urllib.error

    url        = monitor["target"]
    timeout    = monitor.get("timeout", 10)
    method     = (monitor.get("http_method") or "GET").upper()
    exp_status = monitor.get("http_expected_status") or 200
    keyword    = monitor.get("http_keyword")
    ignore_ssl = monitor.get("http_ignore_ssl", False)

    start = time.monotonic()

    def _do() -> dict:
        ctx = ssl.create_default_context()
        if ignore_ssl:
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE

        req = urllib.request.Request(url, method=method)
        req.add_header("User-Agent", "TekNaBox-Monitor/1.0")

        cert_days  = None
        status_code = None
        body_text   = None

        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                rtt = round((time.monotonic() - start) * 1000, 1)
                status_code = resp.status
                body_text   = resp.read(32768).decode("utf-8", errors="replace") if keyword else None

                # SSL cert expiry
                if url.startswith("https://"):
                    try:
                        import datetime as dt_mod
                        cert = resp.fp.raw._sock.getpeercert()
                        if cert and "notAfter" in cert:
                            exp  = dt_mod.datetime.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y %Z")
                            cert_days = (exp - dt_mod.datetime.utcnow()).days
                    except Exception:
                        pass
        except urllib.error.HTTPError as e:
            rtt         = round((time.monotonic() - start) * 1000, 1)
            status_code = e.code
            body_text   = e.read(32768).decode("utf-8", errors="replace") if keyword else None

        success = (status_code == exp_status)
        keyword_match = None
        if keyword is not None and body_text is not None:
            keyword_match = keyword.lower() in body_text.lower()
            if not keyword_match:
                success = False

        error = None
        if status_code != exp_status:
            error = f"HTTP {status_code} (expected {exp_status})"
        elif keyword is not None and not keyword_match:
            error = f"keyword '{keyword}' not found"

        return {
            "monitor_id":      monitor["id"],
            "success":         success,
            "rtt_ms":          rtt,
            "status_code":     status_code,
            "cert_expiry_days": cert_days,
            "keyword_match":   keyword_match,
            "error":           error,
            "checked_at":      _now(),
        }

    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, _do), timeout=timeout + 5
        )
    except asyncio.TimeoutError:
        return _fail(monitor, "HTTP timeout")
    except Exception as e:
        return _fail(monitor, str(e))


# ── DNS ───────────────────────────────────────────────────────────────────────

async def _check_dns(monitor: dict) -> dict:
    host        = monitor["target"]
    record_type = (monitor.get("dns_record_type") or "A").upper()
    expected    = monitor.get("dns_expected_value")
    timeout     = monitor.get("timeout", 10)
    start       = time.monotonic()

    family = socket.AF_INET6 if record_type == "AAAA" else socket.AF_INET

    loop = asyncio.get_event_loop()
    try:
        info = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: socket.getaddrinfo(host, None, family)),
            timeout=timeout,
        )
        rtt_ms     = round((time.monotonic() - start) * 1000, 1)
        resolved   = list({r[4][0] for r in info}) if info else []
        dns_result = ", ".join(resolved)
        success    = True
        error      = None

        if expected:
            success = expected in resolved
            if not success:
                error = f"expected {expected!r}, got {dns_result!r}"

        return {
            "monitor_id": monitor["id"],
            "success":    success,
            "rtt_ms":     rtt_ms,
            "dns_result": dns_result,
            "error":      error,
            "checked_at": _now(),
        }
    except asyncio.TimeoutError:
        return _fail(monitor, "DNS timeout")
    except Exception as e:
        return _fail(monitor, str(e))


# ── Utilities ─────────────────────────────────────────────────────────────────

def _fail(monitor: dict, error: str) -> dict:
    return {
        "monitor_id": monitor["id"],
        "success":    False,
        "rtt_ms":     None,
        "error":      error,
        "checked_at": _now(),
    }


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
