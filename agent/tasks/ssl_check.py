"""
Task: run_ssl_check
Payload:
  targets: list of {host, port} dicts  e.g. [{"host":"example.com","port":443}]
           OR list of "host:port" strings
           port defaults to 443 if omitted
  warn_days: flag cert as expiring_soon if < this many days remain (default: 30)

Checks SSL/TLS certificate validity, expiry, SANs, and cipher suite for each
target. No external dependencies — pure Python ssl stdlib.
"""

import asyncio
import logging
import re
import socket
import ssl
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')
MAX_TARGETS  = 30

# SSL contexts created once and reused across all targets
_CTX_STRICT: ssl.SSLContext | None = None
_CTX_UNVERIFIED: ssl.SSLContext | None = None


def _get_ssl_context(verify: bool = True) -> ssl.SSLContext:
    global _CTX_STRICT, _CTX_UNVERIFIED
    if verify:
        if _CTX_STRICT is None:
            _CTX_STRICT = ssl.create_default_context()
        return _CTX_STRICT
    if _CTX_UNVERIFIED is None:
        _CTX_UNVERIFIED = ssl.create_default_context()
        _CTX_UNVERIFIED.check_hostname = False
        _CTX_UNVERIFIED.verify_mode    = ssl.CERT_NONE
    return _CTX_UNVERIFIED


async def run(payload: dict) -> dict:
    raw      = payload.get("targets", [])
    warn_days = int(payload.get("warn_days", 30))

    targets = _parse_targets(raw)
    if not targets:
        raise ValueError("No valid targets provided")

    results = await asyncio.gather(
        *[_check_target(h, p, warn_days) for h, p in targets[:MAX_TARGETS]],
        return_exceptions=False,
    )

    expiring  = [r for r in results if r.get("status") == "expiring_soon"]
    expired   = [r for r in results if r.get("status") == "expired"]
    errors    = [r for r in results if r.get("status") == "error"]
    ok        = [r for r in results if r.get("status") == "ok"]

    return {
        "targets_checked": len(results),
        "summary": {
            "ok":            len(ok),
            "expiring_soon": len(expiring),
            "expired":       len(expired),
            "errors":        len(errors),
        },
        "results":  results,
        "warn_days": warn_days,
    }


def _parse_targets(raw: list) -> list[tuple[str, int]]:
    out = []
    for item in raw:
        if isinstance(item, dict):
            host = str(item.get("host", ""))
            port = int(item.get("port", 443))
        elif isinstance(item, str) and ":" in item:
            parts = item.rsplit(":", 1)
            host  = parts[0]
            try:
                port = int(parts[1])
            except ValueError:
                continue
        elif isinstance(item, str):
            host = item
            port = 443
        else:
            continue

        host = host.strip()
        for prefix in ("https://", "http://"):
            if host.startswith(prefix):
                host = host[len(prefix):]
                break
        host = host.rstrip("/")
        if SAFE_HOST_RE.match(host) and 1 <= port <= 65535:
            out.append((host, port))
    return out


async def _check_target(host: str, port: int, warn_days: int) -> dict:
    loop   = asyncio.get_running_loop()
    result = {"host": host, "port": port}
    try:
        info = await asyncio.wait_for(
            loop.run_in_executor(None, _fetch_cert_info, host, port),
            timeout=10,
        )
        result.update(info)

        # Determine status
        days = info.get("days_remaining")
        if days is None:
            result["status"] = "error"
            result["error"]  = "Could not determine expiry"
        elif days < 0:
            result["status"] = "expired"
        elif days < warn_days:
            result["status"] = "expiring_soon"
        else:
            result["status"] = "ok"

    except asyncio.TimeoutError:
        result["status"] = "error"
        result["error"]  = "Connection timed out"
    except Exception as e:
        result["status"] = "error"
        result["error"]  = str(e)[:200]

    return result


def _fetch_cert_info(host: str, port: int) -> dict:
    verify_error = None
    for verify in (True, False):
        ctx = _get_ssl_context(verify=verify)
        try:
            with socket.create_connection((host, port), timeout=8) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                    cert        = ssock.getpeercert()
                    cipher      = ssock.cipher()
                    tls_version = ssock.version()
            return {
                "valid":        verify and verify_error is None,
                "verify_error": verify_error,
                "tls_version":  tls_version,
                "cipher":       cipher[0] if cipher else None,
                **_parse_cert(cert),
            }
        except ssl.SSLCertVerificationError as e:
            if verify:
                verify_error = str(e)
                continue  # retry without strict verification
            raise


def _parse_cert(cert: dict) -> dict:
    now    = datetime.now(timezone.utc)
    result = {}

    # Subject CN
    subject = dict(x[0] for x in cert.get("subject", []))
    result["common_name"] = subject.get("commonName")

    # Issuer
    issuer = dict(x[0] for x in cert.get("issuer", []))
    result["issuer"] = issuer.get("organizationName") or issuer.get("commonName")

    # SANs
    sans = []
    for typ, val in cert.get("subjectAltName", []):
        if typ == "DNS":
            sans.append(val)
    result["sans"] = sans

    # Expiry
    not_after = cert.get("notAfter")
    if not_after:
        try:
            expiry = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
            result["expires_at"]     = expiry.isoformat()
            result["days_remaining"] = (expiry - now).days
        except ValueError:
            result["days_remaining"] = None
    else:
        result["days_remaining"] = None

    # Not before
    not_before = cert.get("notBefore")
    if not_before:
        try:
            issued = datetime.strptime(not_before, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
            result["issued_at"] = issued.isoformat()
        except ValueError:
            pass

    return result
