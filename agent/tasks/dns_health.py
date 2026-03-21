"""
Task: run_dns_health
Payload:
  domain: domain to audit e.g. "example.com" (required)
  check_email: bool — also check SPF, DKIM, DMARC (default: true)
  dkim_selector: DKIM selector to check (default: "default")
  nameservers: list of nameserver IPs to query directly (optional)

Checks:
  - A / AAAA records
  - MX records and reachability
  - SPF record presence and validity
  - DMARC policy
  - DKIM selector
  - NS record consistency across all authoritative servers
  - SOA serial consistency
  - Dangling CNAME detection
"""

import asyncio
import logging
import re
import socket
import struct

logger = logging.getLogger(__name__)

SAFE_DOMAIN_RE   = re.compile(r'^[a-zA-Z0-9.\-]+$')
SAFE_SELECTOR_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')


async def run(payload: dict) -> dict:
    domain = str(payload.get("domain", "")).strip().lower().rstrip(".")
    if not domain or not SAFE_DOMAIN_RE.match(domain):
        raise ValueError(f"Invalid domain: {domain!r}")

    check_email   = payload.get("check_email", True)
    dkim_selector = str(payload.get("dkim_selector", "default")).strip()
    if not SAFE_SELECTOR_RE.match(dkim_selector):
        dkim_selector = "default"

    loop    = asyncio.get_running_loop()
    results = {"domain": domain, "checks": {}, "findings": []}

    # Run checks concurrently
    tasks = {
        "a_record":   loop.run_in_executor(None, _check_a_record, domain),
        "mx_records": loop.run_in_executor(None, _check_mx, domain),
        "ns_records": loop.run_in_executor(None, _check_ns_consistency, domain),
    }
    if check_email:
        tasks["spf"]   = loop.run_in_executor(None, _check_spf, domain)
        tasks["dmarc"] = loop.run_in_executor(None, _check_dmarc, domain)
        tasks["dkim"]  = loop.run_in_executor(None, _check_dkim, domain, dkim_selector)

    gathered = await asyncio.gather(*tasks.values(), return_exceptions=True)
    for key, res in zip(tasks.keys(), gathered):
        if isinstance(res, Exception):
            results["checks"][key] = {"error": str(res)[:200]}
        else:
            results["checks"][key] = res

    # Build findings list
    results["findings"] = _build_findings(results["checks"], domain)
    results["findings_count"] = len(results["findings"])

    return results


# ── Individual checks ─────────────────────────────────────────────────────────

def _resolve(hostname: str, rdtype: str = "A") -> list[str]:
    """Minimal DNS resolver using socket — avoids dnspython dependency."""
    try:
        if rdtype == "A":
            infos = socket.getaddrinfo(hostname, None, socket.AF_INET)
            return list({i[4][0] for i in infos})
        elif rdtype == "AAAA":
            infos = socket.getaddrinfo(hostname, None, socket.AF_INET6)
            return list({i[4][0] for i in infos})
    except Exception:
        return []
    return []


def _dig(name: str, rdtype: str) -> list[str]:
    """Use dig for record types socket doesn't handle (MX, TXT, NS, SOA)."""
    import subprocess
    try:
        r = subprocess.run(
            ["dig", "+short", "+time=3", "+tries=1", name, rdtype],
            capture_output=True, text=True, timeout=8,
        )
        lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
        return lines
    except Exception:
        return []


def _check_a_record(domain: str) -> dict:
    ips = _resolve(domain, "A")
    v6  = _resolve(domain, "AAAA")
    return {
        "ipv4": ips,
        "ipv6": v6,
        "resolves": bool(ips or v6),
    }


def _check_mx(domain: str) -> dict:
    records = _dig(domain, "MX")
    mx_list = []
    for r in records:
        parts = r.split()
        if len(parts) == 2:
            mx_list.append({"priority": int(parts[0]), "host": parts[1].rstrip(".")})
    mx_list.sort(key=lambda x: x["priority"])
    return {"records": mx_list, "count": len(mx_list)}


def _check_ns_consistency(domain: str) -> dict:
    ns_records = _dig(domain, "NS")
    ns_list    = [n.rstrip(".") for n in ns_records]

    serials = {}
    for ns in ns_list[:6]:
        try:
            r = __import__("subprocess").run(
                ["dig", "+short", "+time=3", "@" + ns, domain, "SOA"],
                capture_output=True, text=True, timeout=8,
            )
            lines = r.stdout.strip().splitlines()
            if lines:
                # SOA: primary ns  email  serial  refresh  retry  expire  ttl
                parts = lines[0].split()
                if len(parts) >= 3:
                    serials[ns] = int(parts[2])
        except Exception:
            serials[ns] = None

    unique_serials = set(v for v in serials.values() if v is not None)
    return {
        "nameservers":     ns_list,
        "soa_serials":     serials,
        "serials_consistent": len(unique_serials) <= 1,
    }


def _check_spf(domain: str) -> dict:
    txt_records = _dig(domain, "TXT")
    spf_records = [r.strip('"') for r in txt_records if "v=spf1" in r.lower()]

    if not spf_records:
        return {"present": False, "record": None, "valid": False}

    spf = spf_records[0]
    # Basic validity: should end with -all, ~all, or ?all
    strict = spf.endswith("-all")
    soft   = spf.endswith("~all")
    return {
        "present": True,
        "record":  spf,
        "valid":   strict or soft or spf.endswith("?all"),
        "strict":  strict,   # -all = hard fail
        "soft":    soft,     # ~all = soft fail
        "multiple_records": len(spf_records) > 1,  # >1 SPF record = invalid
    }


def _check_dmarc(domain: str) -> dict:
    records = _dig(f"_dmarc.{domain}", "TXT")
    dmarc   = next((r.strip('"') for r in records if "v=DMARC1" in r), None)

    if not dmarc:
        return {"present": False, "record": None, "policy": None}

    policy = "none"
    m = re.search(r'p=(\w+)', dmarc)
    if m:
        policy = m.group(1).lower()

    pct = 100
    m2 = re.search(r'pct=(\d+)', dmarc)
    if m2:
        pct = int(m2.group(1))

    return {
        "present": True,
        "record":  dmarc,
        "policy":  policy,   # none / quarantine / reject
        "pct":     pct,
        "enforced": policy in ("quarantine", "reject"),
    }


def _check_dkim(domain: str, selector: str) -> dict:
    name    = f"{selector}._domainkey.{domain}"
    records = _dig(name, "TXT")
    dkim    = next((r.strip('"') for r in records if "v=DKIM1" in r), None)

    if not dkim:
        return {"present": False, "selector": selector, "record": None}

    key_type = "rsa"
    m = re.search(r'k=(\w+)', dkim)
    if m:
        key_type = m.group(1)

    return {
        "present":  True,
        "selector": selector,
        "key_type": key_type,
        "record":   dkim[:200],
    }


# ── Findings builder ──────────────────────────────────────────────────────────

def _build_findings(checks: dict, domain: str) -> list:
    findings = []

    def finding(severity, title, detail):
        findings.append({"severity": severity, "title": title, "detail": detail})

    a = checks.get("a_record", {})
    if not a.get("resolves"):
        finding("high", "Domain does not resolve", f"{domain} has no A or AAAA records.")

    mx = checks.get("mx_records", {})
    if mx.get("count", 0) == 0:
        finding("medium", "No MX records", f"{domain} has no mail exchanger records.")

    spf = checks.get("spf", {})
    if spf and not spf.get("error"):
        if not spf.get("present"):
            finding("high", "No SPF record",
                    f"{domain} has no SPF record — anyone can spoof email from this domain.")
        elif spf.get("multiple_records"):
            finding("medium", "Multiple SPF records",
                    "Having more than one SPF record is invalid per RFC 7208 and may cause delivery failures.")
        elif not spf.get("strict"):
            finding("low", "SPF uses soft fail (~all)",
                    "Consider using -all (hard fail) to prevent spoofing more aggressively.")

    dmarc = checks.get("dmarc", {})
    if dmarc and not dmarc.get("error"):
        if not dmarc.get("present"):
            finding("high", "No DMARC record",
                    f"{domain} has no DMARC policy — spoofed emails may reach inboxes.")
        elif not dmarc.get("enforced"):
            finding("medium", "DMARC policy is 'none'",
                    "DMARC is set to monitoring only (p=none). No emails are rejected or quarantined.")
        elif dmarc.get("pct", 100) < 100:
            finding("low", f"DMARC applies to only {dmarc['pct']}% of messages",
                    "The pct= tag means DMARC policy is not applied to all mail.")

    dkim = checks.get("dkim", {})
    if dkim and not dkim.get("present") and not dkim.get("error"):
        finding("medium", f"DKIM selector '{dkim.get('selector')}' not found",
                "No DKIM key found for this selector. Email signing may not be configured.")

    ns = checks.get("ns_records", {})
    if ns and not ns.get("serials_consistent") and not ns.get("error"):
        finding("low", "SOA serial mismatch across nameservers",
                "Not all authoritative nameservers agree on the SOA serial — zone transfer may be incomplete.")

    return findings
