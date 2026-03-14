"""
Task: run_http_monitor
Payload:
  targets: list of URLs or {url, expected_status, content_match, follow_redirects} dicts
  timeout: seconds per request (default: 10)

Checks each URL for:
  - HTTP status code
  - Response time
  - SSL certificate validity and days remaining
  - Optional content match (substring or regex)
  - Redirect chain
"""

import asyncio
import logging
import re
import ssl
import socket
import time
import urllib.parse
import urllib.request
import urllib.error

logger = logging.getLogger(__name__)

SAFE_URL_RE = re.compile(r'^https?://')
MAX_TARGETS = 20


async def run(payload: dict) -> dict:
    raw     = payload.get("targets", [])
    timeout = float(payload.get("timeout", 10))

    targets = _parse_targets(raw)
    if not targets:
        raise ValueError("No valid targets provided")

    loop    = asyncio.get_running_loop()
    results = await asyncio.gather(
        *[
            asyncio.wait_for(
                loop.run_in_executor(None, _check_url, t, timeout),
                timeout=timeout + 5,
            )
            for t in targets[:MAX_TARGETS]
        ],
        return_exceptions=True,
    )

    out = []
    for t, r in zip(targets[:MAX_TARGETS], results):
        if isinstance(r, Exception):
            out.append({"url": t["url"], "status": "error", "error": str(r)[:200]})
        else:
            out.append(r)

    up   = sum(1 for r in out if r.get("up"))
    down = sum(1 for r in out if not r.get("up") and r.get("status") != "error")
    err  = sum(1 for r in out if r.get("status") == "error")

    return {
        "targets_checked": len(out),
        "summary":  {"up": up, "down": down, "errors": err},
        "results":  out,
    }


def _parse_targets(raw: list) -> list:
    out = []
    for item in raw:
        if isinstance(item, str):
            url = item.strip()
            if SAFE_URL_RE.match(url):
                out.append({"url": url, "expected_status": 200,
                            "content_match": None, "follow_redirects": True})
        elif isinstance(item, dict):
            url = str(item.get("url", "")).strip()
            if SAFE_URL_RE.match(url):
                out.append({
                    "url":              url,
                    "expected_status":  item.get("expected_status", 200),
                    "content_match":    item.get("content_match"),
                    "follow_redirects": item.get("follow_redirects", True),
                })
    return out


def _check_url(target: dict, timeout: float) -> dict:
    url              = target["url"]
    expected_status  = target["expected_status"]
    content_match    = target.get("content_match")
    follow_redirects = target.get("follow_redirects", True)

    result = {"url": url, "up": False}
    parsed = urllib.parse.urlparse(url)
    is_https = parsed.scheme == "https"

    # SSL cert check for HTTPS targets
    if is_https:
        try:
            cert_info = _get_cert_info(parsed.hostname, parsed.port or 443)
            result["ssl"] = cert_info
        except Exception as e:
            result["ssl"] = {"error": str(e)[:100]}

    # HTTP request
    ctx = ssl.create_default_context() if is_https else None
    opener = urllib.request.build_opener()
    if not follow_redirects:
        opener = urllib.request.build_opener(NoRedirect)

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "MSP-Agent/2.0 health-check"},
        )
        t0 = time.time()
        with opener.open(req, timeout=timeout) if ctx is None else \
             urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
            response_ms    = round((time.time() - t0) * 1000, 1)
            status_code    = resp.status
            body           = resp.read(4096).decode("utf-8", errors="replace")
            final_url      = resp.url
            content_type   = resp.headers.get("Content-Type", "")

        status_ok = (status_code == expected_status)
        match_ok  = True
        match_found = None
        if content_match:
            match_found = bool(re.search(content_match, body, re.IGNORECASE))
            match_ok    = match_found

        result.update({
            "up":            status_ok and match_ok,
            "status_code":   status_code,
            "expected_status": expected_status,
            "status_ok":     status_ok,
            "response_ms":   response_ms,
            "final_url":     final_url if final_url != url else None,
            "redirected":    final_url != url,
            "content_type":  content_type,
            "content_match": match_found,
        })

    except urllib.error.HTTPError as e:
        result.update({
            "up":          e.code == expected_status,
            "status_code": e.code,
            "response_ms": None,
            "error":       str(e),
        })
    except urllib.error.URLError as e:
        result.update({"status": "error", "error": str(e.reason)[:150]})
    except Exception as e:
        result.update({"status": "error", "error": str(e)[:150]})

    return result


def _get_cert_info(host: str, port: int) -> dict:
    ctx = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=6) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as ssock:
            cert = ssock.getpeercert()
    from datetime import datetime, timezone
    not_after = cert.get("notAfter")
    if not_after:
        expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        days   = (expiry - datetime.now(timezone.utc)).days
        return {"valid": True, "days_remaining": days, "expires_at": expiry.isoformat()}
    return {"valid": True, "days_remaining": None}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
