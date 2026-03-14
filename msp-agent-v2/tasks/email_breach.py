"""
Task: run_email_breach
Payload:
  domain: domain to check e.g. "example.com" (required)
  hibp_api_key: Have I Been Pwned API key (required for domain search)

Checks a domain against the Have I Been Pwned API for known breaches.
Requires a HIBP API key (https://haveibeenpwned.com/API/Key).

The API key is used only for this request and never stored.
"""

import asyncio
import logging
import re
import ssl
import urllib.error
import urllib.request
import json

logger = logging.getLogger(__name__)

SAFE_DOMAIN_RE  = re.compile(r'^[a-zA-Z0-9.\-]+$')
HIBP_BASE       = "https://haveibeenpwned.com/api/v3"


async def run(payload: dict) -> dict:
    domain      = str(payload.get("domain", "")).strip().lower()
    hibp_key    = str(payload.get("hibp_api_key", "")).strip()

    if not domain or not SAFE_DOMAIN_RE.match(domain):
        raise ValueError(f"Invalid domain: {domain!r}")
    if not hibp_key:
        raise ValueError("hibp_api_key is required. Get one at haveibeenpwned.com/API/Key")

    loop = asyncio.get_running_loop()

    # Domain breach search
    breaches = await asyncio.wait_for(
        loop.run_in_executor(None, _get_domain_breaches, domain, hibp_key),
        timeout=20,
    )

    total_accounts = sum(b.get("PwnCount", 0) for b in breaches)
    sensitive      = [b for b in breaches if b.get("IsSensitive")]
    verified       = [b for b in breaches if b.get("IsVerified")]

    # Clean up breach records for output
    clean_breaches = [_clean_breach(b) for b in breaches]
    clean_breaches.sort(key=lambda b: b.get("breach_date", ""), reverse=True)

    severity = "info"
    if total_accounts > 10000:
        severity = "critical"
    elif total_accounts > 1000:
        severity = "high"
    elif total_accounts > 0:
        severity = "medium"

    findings = []
    if breaches:
        findings.append({
            "severity": severity,
            "title":    f"{domain} found in {len(breaches)} data breach(es)",
            "detail":   (
                f"{total_accounts:,} account(s) from {domain} appeared in breach data. "
                f"Most recent: {clean_breaches[0]['name'] if clean_breaches else 'unknown'}. "
                f"Affected users should change passwords and enable MFA."
            ),
        })

    return {
        "domain":            domain,
        "breaches_found":    len(breaches),
        "total_accounts":    total_accounts,
        "sensitive_breaches": len(sensitive),
        "verified_breaches": len(verified),
        "severity":          severity,
        "findings":          findings,
        "breaches":          clean_breaches,
    }


def _get_domain_breaches(domain: str, api_key: str) -> list:
    url = f"{HIBP_BASE}/breacheddomain/{domain}"
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        headers={
            "hibp-api-key": api_key,
            "User-Agent":   "MSP-Agent/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []  # No breaches found
        if e.code == 401:
            raise ValueError("Invalid HIBP API key")
        if e.code == 429:
            raise RuntimeError("HIBP rate limit hit — try again in a moment")
        raise RuntimeError(f"HIBP API error: HTTP {e.code}")


def _clean_breach(b: dict) -> dict:
    return {
        "name":         b.get("Name"),
        "title":        b.get("Title"),
        "domain":       b.get("Domain"),
        "breach_date":  b.get("BreachDate"),
        "added_date":   b.get("AddedDate", "")[:10],
        "pwn_count":    b.get("PwnCount", 0),
        "data_classes": b.get("DataClasses", []),
        "is_verified":  b.get("IsVerified", False),
        "is_sensitive": b.get("IsSensitive", False),
        "is_fabricated": b.get("IsFabricated", False),
    }
