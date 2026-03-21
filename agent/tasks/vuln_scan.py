"""
Task: run_vuln_scan
Payload:
  targets:    list of IPs/CIDRs
  intensity:  "safe" | "default" | "aggressive"  (default: safe)
    safe        — scripts: safe,auth        | top-100 ports  | 120s host-timeout | version-intensity 2
    default     — scripts: safe,auth,default | top-200 ports  | 300s host-timeout | version-intensity 3
    aggressive  — scripts: safe,auth,default,vuln | top-500 ports | 600s host-timeout | version-intensity 5
  ports:      explicit port list e.g. "80,443,8080"  (overrides top_ports)
  top_ports:  integer — override default port count for the chosen intensity (max: 1000)
  timeout:    override per-host timeout in seconds (rarely needed)

All intensities use -Pn (skip ICMP host discovery — Windows hosts block ping).
"""

import asyncio
import datetime
import logging
import re
import xml.etree.ElementTree as ET
from typing import Optional

logger = logging.getLogger(__name__)

# Only allow IPs, CIDRs, and ranges -- no hostnames to prevent SSRF
SAFE_TARGET_RE = re.compile(r'^[\d./\-,\s]+$')

SCRIPT_SETS = {
    "safe":       "safe,auth",
    "default":    "safe,auth,default",
    "aggressive": "safe,auth,default,vuln",
}

# Scripts whose output is pure noise -- never produce a finding
NOISE_SCRIPTS = {
    "http-fetch",
    "http-date",
    "http-useragent-tester",
    "http-mobileversion-checker",
    "http-referer-checker",
    "http-comments-displayer",
    "ssl-date",
    "clock-skew",
    "smb2-time",
    "fcrdns",
    "port-states",
    "smb-mbenum",
    "nbstat",
    "msrpc-enum",
}

# Scripts that produce only informational context, handled by dedicated parsers
# or suppressed -- not emitted as generic findings
INFO_ONLY_SCRIPTS = {
    "http-title",
    "rdp-enum-encryption",
    "smb-os-discovery",
    "smb2-capabilities",
    "smb2-security-mode",
    "http-server-header",
    "smb-enum-services",
    "http-xssed",
}


# ── CVSS helpers ──────────────────────────────────────────────────────────────

def _cvss_to_severity(score: float) -> str:
    if score >= 9.0: return "critical"
    if score >= 7.0: return "high"
    if score >= 4.0: return "medium"
    if score >= 0.1: return "low"
    return "info"


# ── Vulners output parser ─────────────────────────────────────────────────────
# vulners output format (tab-separated per line):
#   CVE-XXXX-XXXXX   7.5   https://vulners.com/cve/...

VULNERS_CVE_RE = re.compile(
    r'(CVE-\d{4}-\d+)\s+([\d.]+)\s+(https?://\S+)',
    re.MULTILINE,
)

def _parse_vulners(output: str) -> list:
    findings = []
    for m in VULNERS_CVE_RE.finditer(output):
        cve_id = m.group(1)
        try:
            cvss = float(m.group(2))
        except ValueError:
            cvss = 0.0
        findings.append({
            "cve_id":   cve_id,
            "cvss":     cvss,
            "severity": _cvss_to_severity(cvss),
        })
    findings.sort(key=lambda x: x["cvss"], reverse=True)
    return findings


# ── Nmap VULNERABLE block parser ──────────────────────────────────────────────

VULN_TITLE_RE = re.compile(r'VULNERABLE:\s*\n\s*(.+)', re.IGNORECASE)
VULN_CVE_RE   = re.compile(r'CVE:(CVE-\d{4}-\d+)', re.IGNORECASE)

def _parse_vuln_block(script_id: str, output: str) -> dict:
    title  = None
    cve_id = None

    m = VULN_TITLE_RE.search(output)
    if m:
        title = m.group(1).strip()

    m = VULN_CVE_RE.search(output)
    if m:
        cve_id = m.group(1)

    if not title:
        title = _script_id_to_title(script_id)

    return {"title": title, "cve_id": cve_id}


KNOWN_SCRIPT_TITLES = {
    "smb-vuln-ms17-010":        "MS17-010 EternalBlue SMB Remote Code Execution",
    "smb-vuln-ms08-067":        "MS08-067 NetAPI Remote Code Execution",
    "smb-vuln-cve-2017-7494":   "CVE-2017-7494 SambaCry Remote Code Execution",
    "ssl-poodle":               "SSL POODLE Information Leak (CVE-2014-3566)",
    "ssl-heartbleed":           "OpenSSL Heartbleed (CVE-2014-0160)",
    "http-shellshock":          "Shellshock Bash RCE (CVE-2014-6271)",
    "rdp-vuln-ms12-020":        "MS12-020 RDP Denial of Service",
    "http-vuln-cve2017-5638":   "Apache Struts RCE (CVE-2017-5638)",
    "http-vuln-cve2014-3704":   "Drupalgeddon SQL Injection (CVE-2014-3704)",
    "smb-vuln-ms10-061":        "MS10-061 Print Spooler RCE",
    "smb-vuln-ms10-054":        "MS10-054 SMB Pool Overflow",
    "ftp-anon":                 "Anonymous FTP Login Allowed",
    "http-methods":             "Risky HTTP Methods Enabled",
    "http-security-headers":    "Missing HTTP Security Headers",
    "smb-security-mode":        "SMB Security Mode",
    "ssl-cert":                 "SSL Certificate",
    "vulners":                  "Known CVE (Vulners Database)",
    "smb-protocols":            "SMBv1 Protocol Enabled",
}

def _script_id_to_title(script_id: str) -> str:
    if script_id in KNOWN_SCRIPT_TITLES:
        return KNOWN_SCRIPT_TITLES[script_id]
    name = script_id
    for prefix in ("smb-vuln-", "http-vuln-", "rdp-vuln-", "ssl-", "http-", "smb-", "ftp-"):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return name.replace("-", " ").replace("_", " ").title()


# ── SSL cert expiry ───────────────────────────────────────────────────────────

SSL_EXPIRE_RE = re.compile(r'Not valid after:\s+(\d{4}-\d{2}-\d{2})')
SSL_CN_RE     = re.compile(r'commonName=([^\n/,]+)')

def _parse_ssl_cert(ip, port, protocol, service, output) -> Optional[dict]:
    m = SSL_EXPIRE_RE.search(output)
    if not m:
        return None
    try:
        expiry = datetime.datetime.strptime(m.group(1), "%Y-%m-%d").replace(
            tzinfo=datetime.timezone.utc
        )
    except ValueError:
        return None

    now  = datetime.datetime.now(datetime.timezone.utc)
    days = (expiry - now).days

    cn_m  = SSL_CN_RE.search(output)
    cn    = cn_m.group(1).strip() if cn_m else "unknown"

    if days < 0:
        return {
            "ip": ip, "port": port, "protocol": protocol, "service": service,
            "script": "ssl-cert",
            "title":  f"SSL Certificate Expired: {cn}",
            "cve_id": None, "cvss": None, "severity": "high",
            "output": output[:400],
        }
    elif days <= 30:
        return {
            "ip": ip, "port": port, "protocol": protocol, "service": service,
            "script": "ssl-cert",
            "title":  f"SSL Certificate Expiring in {days} Days: {cn}",
            "cve_id": None, "cvss": None, "severity": "medium",
            "output": output[:400],
        }
    elif days <= 60:
        return {
            "ip": ip, "port": port, "protocol": protocol, "service": service,
            "script": "ssl-cert",
            "title":  f"SSL Certificate Expiring Soon ({days} days): {cn}",
            "cve_id": None, "cvss": None, "severity": "low",
            "output": output[:400],
        }
    return None


# ── Missing HTTP security headers ─────────────────────────────────────────────

SECURITY_HEADERS = [
    "x-frame-options",
    "x-content-type-options",
    "content-security-policy",
    "strict-transport-security",
    "referrer-policy",
    "permissions-policy",
]

def _check_http_security_headers(ip, port, protocol, service, output) -> Optional[dict]:
    ol = output.lower().strip()
    missing = [h for h in SECURITY_HEADERS if h not in ol]
    if not missing:
        return None
    if len(missing) == len(SECURITY_HEADERS):
        detail = "No HTTP security headers present (no X-Frame-Options, CSP, HSTS, etc.)"
    else:
        detail = "Missing headers: " + ", ".join(missing)
    return {
        "ip": ip, "port": port, "protocol": protocol, "service": service,
        "script": "http-security-headers",
        "title":  f"Missing HTTP Security Headers on port {port}",
        "cve_id": None, "cvss": None, "severity": "medium",
        "output": detail,
    }


# ── HTTP TRACE ────────────────────────────────────────────────────────────────

def _check_http_methods(ip, port, protocol, service, output) -> Optional[dict]:
    if "TRACE" not in output.upper():
        return None
    return {
        "ip": ip, "port": port, "protocol": protocol, "service": service,
        "script": "http-methods",
        "title":  f"Risky HTTP Method Enabled (TRACE) on port {port}",
        "cve_id": None, "cvss": 5.8, "severity": "medium",
        "output": output[:300],
    }


# ── SMBv1 ─────────────────────────────────────────────────────────────────────

def _check_smb_protocols(ip, output) -> Optional[dict]:
    if "NT LM 0.12" not in output and "SMBv1" not in output:
        return None
    return {
        "ip": ip, "port": 445, "protocol": "tcp", "service": "microsoft-ds",
        "script": "smb-protocols",
        "title":  "SMBv1 Protocol Enabled",
        "cve_id": "CVE-2017-0143",
        "cvss":   9.3,
        "severity": "high",
        "output": (
            "SMBv1 (NT LM 0.12) is enabled. SMBv1 is the attack surface for "
            "EternalBlue (MS17-010) and other critical exploits. "
            "Disable: Set-SmbServerConfiguration -EnableSMB1Protocol $false"
        ),
    }


# ── SMB guest session ─────────────────────────────────────────────────────────

def _check_smb_security_mode(ip, output) -> Optional[dict]:
    if "account_used: guest" not in output.lower():
        return None
    return {
        "ip": ip, "port": 445, "protocol": "tcp", "service": "microsoft-ds",
        "script": "smb-security-mode",
        "title":  "SMB Guest/Null Session Permitted",
        "cve_id": None, "cvss": 5.0, "severity": "medium",
        "output": output[:400],
    }


# ── DNS blacklist ─────────────────────────────────────────────────────────────

def _check_dns_blacklist(ip, output) -> Optional[dict]:
    hits = [l.strip() for l in output.splitlines()
            if "spam" in l.lower() or "malware" in l.lower()]
    if not hits:
        return None
    return {
        "ip": ip, "port": None, "protocol": None, "service": None,
        "script": "dns-blacklist",
        "title":  f"IP Listed on {len(hits)} DNS Blacklist(s)",
        "cve_id": None, "cvss": None, "severity": "medium",
        "output": "\n".join(hits)[:400],
    }


# ── Fallback severity classifier ──────────────────────────────────────────────

CRITICAL_PATTERNS = {"ms17-010", "eternalblue", "shellshock", "heartbleed",
                     "ms08-067", "sambacry", "cve-2017-7494"}
HIGH_PATTERNS     = {"smb-vuln", "http-vuln", "ssl-heartbleed", "rdp-vuln",
                     "ftp-anon", "ms12-020"}
MEDIUM_PATTERNS   = {"ssl-dh-params", "ssl-poodle"}

def _classify_severity_fallback(script_id: str, output: str) -> str:
    sl = script_id.lower()
    ol = output.lower()
    for p in CRITICAL_PATTERNS:
        if p in sl or p in ol:
            return "critical"
    for p in HIGH_PATTERNS:
        if p in sl:
            return "high"
    if "state: vulnerable" in ol or "state: likely vulnerable" in ol:
        return "high"
    if "vulnerable" in ol and "not vulnerable" not in ol:
        return "high"
    for p in MEDIUM_PATTERNS:
        if p in sl:
            return "medium"
    return "info"


# ── Deduplication ─────────────────────────────────────────────────────────────

def _dedup_findings(findings: list) -> list:
    """Keep highest-severity finding per (script, port) combination."""
    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    seen = {}
    for f in findings:
        key = (f.get("script", ""), f.get("port"))
        if key not in seen:
            seen[key] = f
        else:
            if sev_order.get(f.get("severity", "info"), 4) < sev_order.get(seen[key].get("severity", "info"), 4):
                seen[key] = f
    return list(seen.values())


# ── Main task entry point ─────────────────────────────────────────────────────

async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    targets = [t.strip() for t in raw_targets if SAFE_TARGET_RE.match(str(t).strip())]
    if not targets:
        raise ValueError("No valid targets provided")

    intensity = payload.get("intensity", "safe")
    if intensity not in SCRIPT_SETS:
        intensity = "safe"

    scripts = SCRIPT_SETS[intensity]

    # Scale timeouts and version detection depth with intensity.
    # safe:       fast — small port list, shallow version probing, tight timeout
    # default:    moderate — broader ports, medium probing, more time
    # aggressive: thorough — large port list, deep probing, generous timeout
    INTENSITY_SETTINGS = {
        #               ver_intensity  host_timeout_s  default_top_ports  default_timeout
        "safe":       (2,             120,            100,                90),
        "default":    (3,             300,            200,                180),
        "aggressive": (5,             600,            500,                300),
    }
    ver_intensity, host_timeout_s, default_top_ports, default_timeout = INTENSITY_SETTINGS[intensity]

    timeout = int(payload.get("timeout", default_timeout))

    if "ports" in payload:
        ports_str = str(payload["ports"])
        if not re.match(r'^[\d,\-]+$', ports_str):
            raise ValueError(f"Invalid ports: {ports_str!r}")
        port_args = ["-p", ports_str]
    else:
        top_n = min(int(payload.get("top_ports", default_top_ports)), 1000)
        port_args = ["--top-ports", str(top_n)]

    cmd = [
        "nmap",
        "-Pn",                                           # skip ICMP host discovery — Windows blocks ping
        "-sV", "--version-intensity", str(ver_intensity),
        f"--script={scripts}",
        "--script-timeout", "30s",
        "--host-timeout", f"{host_timeout_s}s",
        *port_args,
        "-oX", "-",
        "--open",
    ] + targets

    logger.info(
        f"vuln_scan intensity={intensity} ver_intensity={ver_intensity} "
        f"host_timeout={host_timeout_s}s targets={targets} port_args={port_args}"
    )

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(
        proc.communicate(), timeout=host_timeout_s * len(targets) + 60
    )

    if proc.returncode not in (0, 1):
        raise RuntimeError(f"nmap failed (rc={proc.returncode}): {stderr.decode()[:400]}")

    return _parse_results(stdout.decode(), intensity)


# ── XML result parser ─────────────────────────────────────────────────────────

def _parse_results(xml_str: str, intensity: str) -> dict:
    try:
        root = ET.fromstring(xml_str)
    except ET.ParseError as e:
        return {"error": str(e), "raw": xml_str[:1000]}

    hosts    = []
    findings = []

    for host in root.findall("host"):
        status = host.find("status")
        if status is None or status.get("state") != "up":
            continue

        addr_el  = host.find("address[@addrtype='ipv4']")
        ip       = addr_el.get("addr") if addr_el is not None else "unknown"

        hn_el    = host.find("hostnames/hostname")
        hostname = hn_el.get("name") if hn_el is not None else None

        os_el  = host.find("os/osmatch")
        os_name = os_el.get("name") if os_el is not None else None

        host_findings = []
        open_ports    = []

        # ── Port-level scripts ────────────────────────────────────────────────
        for port_el in host.findall("ports/port"):
            state_el = port_el.find("state")
            if state_el is None or state_el.get("state") != "open":
                continue

            portid   = int(port_el.get("portid"))
            protocol = port_el.get("protocol", "tcp")
            svc_el   = port_el.find("service")
            service  = svc_el.get("name", "") if svc_el is not None else ""
            version  = ""
            if svc_el is not None:
                parts   = [svc_el.get("product", ""), svc_el.get("version", "")]
                version = " ".join(p for p in parts if p).strip()

            port_findings = []

            for script_el in port_el.findall("script"):
                sid    = script_el.get("id", "")
                output = script_el.get("output", "")

                if sid in NOISE_SCRIPTS:
                    continue
                if output.strip().upper().startswith("ERROR:"):
                    continue

                f = None

                if sid == "vulners":
                    cves = _parse_vulners(output)
                    if not cves:
                        continue
                    top = cves[0]
                    if len(cves) > 1:
                        all_ids = ", ".join(c["cve_id"] for c in cves[:5])
                        suffix  = f" (+{len(cves)-5} more)" if len(cves) > 5 else ""
                        title   = f"Known Vulnerabilities: {all_ids}{suffix}"
                    else:
                        title = f"Known Vulnerability: {top['cve_id']} (CVSS {top['cvss']})"
                    f = {
                        "ip": ip, "port": portid, "protocol": protocol, "service": service,
                        "script": "vulners", "title": title,
                        "cve_id": top["cve_id"], "cvss": top["cvss"],
                        "severity": top["severity"], "output": output[:600],
                    }

                elif sid == "ssl-cert":
                    f = _parse_ssl_cert(ip, portid, protocol, service, output)

                elif sid == "http-security-headers":
                    f = _check_http_security_headers(ip, portid, protocol, service, output)

                elif sid == "http-methods":
                    f = _check_http_methods(ip, portid, protocol, service, output)

                elif sid in INFO_ONLY_SCRIPTS:
                    continue

                else:
                    severity = _classify_severity_fallback(sid, output)
                    if severity == "info":
                        continue
                    parsed = _parse_vuln_block(sid, output)
                    f = {
                        "ip": ip, "port": portid, "protocol": protocol, "service": service,
                        "script": sid, "title": parsed["title"],
                        "cve_id": parsed["cve_id"], "cvss": None,
                        "severity": severity, "output": output[:600],
                    }

                if f is not None:
                    port_findings.append(f)

            open_ports.append({
                "port": portid, "protocol": protocol,
                "service": service, "version": version,
                "findings": port_findings,
            })
            host_findings.extend(port_findings)

        # ── Host-level scripts ────────────────────────────────────────────────
        for script_el in host.findall("hostscript/script"):
            sid    = script_el.get("id", "")
            output = script_el.get("output", "")

            if sid in NOISE_SCRIPTS:
                continue
            if output.strip().upper().startswith("ERROR:"):
                continue

            f = None

            if sid == "smb-protocols":
                f = _check_smb_protocols(ip, output)
            elif sid == "smb-security-mode":
                f = _check_smb_security_mode(ip, output)
            elif sid == "dns-blacklist":
                f = _check_dns_blacklist(ip, output)
            elif sid in INFO_ONLY_SCRIPTS or sid in NOISE_SCRIPTS:
                continue
            else:
                severity = _classify_severity_fallback(sid, output)
                if severity == "info":
                    continue
                parsed = _parse_vuln_block(sid, output)
                f = {
                    "ip": ip, "port": None, "protocol": None, "service": None,
                    "script": sid, "title": parsed["title"],
                    "cve_id": parsed["cve_id"], "cvss": None,
                    "severity": severity, "output": output[:600],
                }

            if f is not None:
                host_findings.append(f)

        deduped = _dedup_findings(host_findings)
        findings.extend(deduped)

        hosts.append({
            "ip": ip, "hostname": hostname, "os": os_name,
            "open_ports": open_ports,
        })

    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    findings.sort(key=lambda f: (sev_order.get(f.get("severity", "info"), 4), f.get("ip", "")))

    return {
        "intensity":      intensity,
        "hosts_scanned":  len(hosts),
        "hosts":          hosts,
        "findings_count": len(findings),
        "findings":       findings,
        "summary": {
            "critical": sum(1 for f in findings if f.get("severity") == "critical"),
            "high":     sum(1 for f in findings if f.get("severity") == "high"),
            "medium":   sum(1 for f in findings if f.get("severity") == "medium"),
            "low":      sum(1 for f in findings if f.get("severity") == "low"),
            "info":     sum(1 for f in findings if f.get("severity") == "info"),
        },
    }
