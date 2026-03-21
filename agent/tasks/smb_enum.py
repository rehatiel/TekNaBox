"""
Task: run_smb_enum
Payload:
  targets: list of IPs/hostnames to enumerate
  username: SMB username (default: "" — null/anonymous session)
  password: SMB password (default: "")
  domain: domain or workgroup (default: "WORKGROUP")
  timeout: seconds per host (default: 15)

Enumerates SMB shares and checks for:
  - Share list (null session or authenticated)
  - Guest / anonymous access per share
  - Sensitive share names (SYSVOL, NETLOGON, backup, etc.)
  - Null session availability
  - OS/version banner from SMB

Uses smbclient — must be installed (apt install smbclient).
Credentials are never logged or persisted.
"""

import asyncio
import logging
import re

logger = logging.getLogger(__name__)

SAFE_HOST_RE   = re.compile(r'^[a-zA-Z0-9.\-]+$')
SAFE_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')

# Share names that warrant a finding if accessible
SENSITIVE_SHARES = {
    "sysvol", "netlogon", "backup", "backups", "bkp",
    "admin$", "c$", "d$", "ipc$", "print$",
    "data", "files", "share", "public", "users", "homes",
}


async def run(payload: dict) -> dict:
    raw_targets = payload.get("targets", [])
    username    = str(payload.get("username", ""))
    password    = str(payload.get("password", ""))
    domain      = str(payload.get("domain", "WORKGROUP"))
    timeout     = int(payload.get("timeout", 15))

    # Validate inputs
    targets = [
        t.strip() for t in raw_targets
        if SAFE_HOST_RE.match(str(t).strip())
    ]
    if not targets:
        raise ValueError("No valid targets provided")

    if not SAFE_DOMAIN_RE.match(domain):
        domain = "WORKGROUP"

    results = await asyncio.gather(
        *[_enum_host(ip, username, password, domain, timeout)
          for ip in targets[:20]],
        return_exceptions=False,
    )

    all_findings = []
    for r in results:
        all_findings.extend(r.get("findings", []))

    return {
        "targets_scanned": len(results),
        "findings_count":  len(all_findings),
        "findings":        all_findings,
        "hosts":           results,
    }


async def _enum_host(host: str, username: str, password: str,
                     domain: str, timeout: int) -> dict:
    result  = {"host": host, "findings": []}
    is_null = not username

    # ── List shares ──────────────────────────────────────────────────────────
    shares, list_error = await _list_shares(host, username, password, domain, timeout)
    result["shares"]       = shares
    result["null_session"] = is_null and bool(shares)

    if is_null and shares:
        result["findings"].append({
            "host":     host,
            "severity": "high",
            "title":    "Null session share listing allowed",
            "detail":   f"SMB allows unauthenticated share enumeration. Found {len(shares)} share(s).",
        })

    # ── Check each share ─────────────────────────────────────────────────────
    for share in shares:
        name       = share.get("name", "")
        name_lower = name.lower()

        # Flag sensitive names
        if any(name_lower == s or name_lower.startswith(s) for s in SENSITIVE_SHARES):
            share["sensitive"] = True
            result["findings"].append({
                "host":     host,
                "severity": "medium",
                "title":    f"Sensitive share accessible: {name}",
                "detail":   f"Share '{name}' is accessible {'without credentials' if is_null else 'with provided credentials'}.",
            })
        else:
            share["sensitive"] = False

        # Check read access
        readable = await _check_share_readable(host, name, username, password, domain, timeout)
        share["readable"] = readable
        if readable and is_null:
            result["findings"].append({
                "host":     host,
                "severity": "high",
                "title":    f"Anonymous read access to share: {name}",
                "detail":   f"'{name}' is readable without authentication.",
            })

    # ── OS banner ────────────────────────────────────────────────────────────
    os_info = await _get_os_banner(host, timeout)
    if os_info:
        result["os_banner"] = os_info

    if list_error and not shares:
        result["error"] = list_error

    return result


async def _run_smbclient(args: list, timeout: int) -> tuple[str, str, int]:
    """Run smbclient with given args. Returns (stdout, stderr, returncode)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "smbclient", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return stdout.decode(errors="replace"), stderr.decode(errors="replace"), proc.returncode
    except FileNotFoundError:
        raise RuntimeError("smbclient not installed — apt install smbclient")
    except asyncio.TimeoutError:
        return "", "timeout", -1


async def _list_shares(host: str, username: str, password: str,
                       domain: str, timeout: int) -> tuple[list, str]:
    """Return list of shares on host."""
    auth_args = _auth_args(username, password, domain)
    stdout, stderr, rc = await _run_smbclient(
        ["-L", host, "--no-pass", "-g"] + auth_args,
        timeout,
    )

    if rc != 0 and not stdout:
        # Try without -g (grepped output flag not all versions support)
        stdout, stderr, rc = await _run_smbclient(
            ["-L", host, "--no-pass"] + auth_args,
            timeout,
        )

    if not stdout and stderr:
        return [], stderr.strip()[:200]

    shares = _parse_share_list(stdout)
    return shares, ""


def _parse_share_list(output: str) -> list:
    shares = []
    for line in output.splitlines():
        line = line.strip()
        # Grepped format: Disk|name|comment
        parts = line.split("|")
        if len(parts) >= 2 and parts[0] in ("Disk", "Printer", "IPC"):
            shares.append({
                "name":    parts[1].strip(),
                "type":    parts[0].strip(),
                "comment": parts[2].strip() if len(parts) > 2 else "",
            })
            continue
        # Fallback: tabular format "    sharename   Disk   comment"
        m = re.match(r'\s+(\S+)\s+(Disk|Printer|IPC)\s*(.*)', line)
        if m:
            shares.append({
                "name":    m.group(1),
                "type":    m.group(2),
                "comment": m.group(3).strip(),
            })
    return shares


async def _check_share_readable(host: str, share: str, username: str,
                                 password: str, domain: str, timeout: int) -> bool:
    auth_args = _auth_args(username, password, domain)
    stdout, stderr, rc = await _run_smbclient(
        [f"//{host}/{share}", "--no-pass", "-c", "ls", "--timeout=5"] + auth_args,
        timeout,
    )
    return rc == 0 and "NT_STATUS_ACCESS_DENIED" not in stderr


async def _get_os_banner(host: str, timeout: int) -> str | None:
    """Get OS info from SMB negotiation via nmap script."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmap", "-p", "445", "--script", "smb-os-discovery",
            "--host-timeout", f"{timeout}s", "-oG", "-", host,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 5)
        output = stdout.decode(errors="replace")
        m = re.search(r'OS: ([^|;\n]+)', output)
        return m.group(1).strip() if m else None
    except Exception:
        return None


def _auth_args(username: str, password: str, domain: str) -> list:
    if username:
        return ["-U", f"{domain}\\{username}%{password}"]
    return ["-N"]
