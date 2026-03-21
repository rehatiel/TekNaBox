"""
Task: run_speedtest
Tests upload/download speed and latency.
Uses speedtest-cli if available, falls back to a basic HTTP download test.
Payload:
  method: "speedtest-cli" | "http" (default: auto-detect)
  test_url: custom URL for HTTP method (optional) — must be https://
"""

import asyncio
import logging
import time
import ssl
import urllib.request
import urllib.parse

logger = logging.getLogger(__name__)

FALLBACK_TEST_URL  = "https://speed.cloudflare.com/__down?bytes=10000000"
ALLOWED_TEST_HOSTS = {
    "speed.cloudflare.com",
    "speedtest.net",
    "fast.com",
    "proof.ovh.net",
    "bouygues.testdebit.info",
}


def _validate_test_url(url: str) -> str:
    """
    Validate a caller-supplied test_url.
    Must be https:// and the hostname must be in ALLOWED_TEST_HOSTS.
    Raises ValueError otherwise.
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        raise ValueError(f"Unparseable test_url: {url!r}")

    if parsed.scheme != "https":
        raise ValueError(f"test_url must use https (got {parsed.scheme!r})")

    host = parsed.hostname or ""
    # Allow exact match or subdomain of an allowed host
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_TEST_HOSTS):
        raise ValueError(
            f"test_url host {host!r} is not in the allowed list. "
            f"Allowed: {', '.join(sorted(ALLOWED_TEST_HOSTS))}"
        )
    return url


async def run(payload: dict) -> dict:
    method = payload.get("method", "auto")

    # Validate test_url if provided — before any execution
    raw_url = payload.get("test_url")
    test_url = None
    if raw_url:
        test_url = _validate_test_url(str(raw_url))

    loop = asyncio.get_running_loop()

    if method == "http":
        return await loop.run_in_executor(None, _http_speed_test, test_url)

    if method in ("auto", "speedtest-cli"):
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, _speedtest_cli),
                timeout=120,
            )
            return result
        except asyncio.TimeoutError:
            logger.warning("speedtest-cli timed out — falling back to HTTP test")
        except FileNotFoundError:
            logger.info("speedtest-cli not found — using HTTP fallback")
        except Exception as e:
            logger.warning(f"speedtest-cli failed: {e} — falling back to HTTP test")

    return await loop.run_in_executor(None, _http_speed_test, test_url)


def _speedtest_cli() -> dict:
    import subprocess
    import json

    result = subprocess.run(
        ["speedtest-cli", "--json", "--timeout", "60"],
        capture_output=True, text=True, timeout=90,
    )
    if result.returncode != 0:
        raise RuntimeError(f"speedtest-cli error: {result.stderr[:200]}")

    data = json.loads(result.stdout)
    return {
        "method":        "speedtest-cli",
        "download_mbps": round(data["download"] / 1e6, 2),
        "upload_mbps":   round(data["upload"] / 1e6, 2),
        "ping_ms":       round(data["ping"], 2),
        "server":        data.get("server", {}).get("name"),
        "isp":           data.get("client", {}).get("isp"),
    }


def _http_speed_test(test_url: str = None) -> dict:
    url = test_url or FALLBACK_TEST_URL
    ctx = ssl.create_default_context()
    total_bytes = 0

    latencies = []
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers={"Range": "bytes=0-0"})
            t0 = time.time()
            with urllib.request.urlopen(req, context=ctx, timeout=10):
                pass
            latencies.append(round((time.time() - t0) * 1000, 2))
        except Exception:
            pass
    avg_latency = round(sum(latencies) / len(latencies), 2) if latencies else None

    download_mbps = None
    try:
        req = urllib.request.Request(url)
        t0 = time.time()
        with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                total_bytes += len(chunk)
        elapsed = time.time() - t0
        download_mbps = round((total_bytes * 8) / elapsed / 1e6, 2) if elapsed > 0 else 0
    except Exception as e:
        logger.warning(f"Download test failed: {e}")

    return {
        "method":            "http",
        "download_mbps":     download_mbps,
        "upload_mbps":       None,
        "ping_ms":           avg_latency,
        "test_url":          url,
        "bytes_downloaded":  total_bytes,
    }
