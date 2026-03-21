"""
Task: run_ad_recon
Payload:
  dc_ip: domain controller IP (required)
  domain: domain name e.g. "CORP.LOCAL" (required)
  username: domain username (required) — NOT stored after task
  password: domain password (required) — NOT stored after task
  base_dn: LDAP base DN e.g. "DC=corp,DC=local" (auto-derived if not set)

Full authenticated AD reconnaissance. Read-only — no modifications to AD.
Credentials used only during task execution and are never persisted.

Collects:
  - Domain info (functional level, forest, NetBIOS name)
  - All domain controllers with OS, FSMO roles, site info
  - Users with logon scripts, home directories, delegation flags
  - Groups: privileged groups with nested/recursive member resolution
  - Password policy (domain-wide) + fine-grained policies (PSOs)
  - Kerberoastable + AS-REP roastable accounts
  - Delegation misconfigurations (unconstrained / constrained / RBCD)
  - AdminSDHolder protected accounts
  - Protected Users group members
  - Managed Service Accounts (MSA) + Group Managed Service Accounts (gMSA)
  - LAPS deployment status + per-computer enrollment coverage
  - Computer objects (servers and workstations) with OS inventory
  - SMB shares with share-level ACLs via rpcclient
  - Trust relationships
  - DNS zones
  - DHCP scopes
  - OU structure with GPO link counts
  - Group Policy Objects with CSE-based type classification (no SYSVOL needed)
"""

import asyncio
import logging
import re
from datetime import datetime, timezone, timedelta

logger = logging.getLogger(__name__)

SAFE_HOST_RE   = re.compile(r'^[a-zA-Z0-9.\-]+$')
SAFE_DOMAIN_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')

# CSE GUID -> GPO capability name
# Appears in gPCMachineExtensionNames / gPCUserExtensionNames
CSE_GUID_MAP = {
    "35378EAC-683F-11D2-A89A-00C04FBBCFA2": "Registry Settings",
    "827D319E-6EAC-11D2-A4EA-00C04F79F83A": "Security Settings",
    "42B5FAAE-6536-11D2-AE5A-0000F87571E3": "Scripts (Logon/Logoff/Startup/Shutdown)",
    "40B6664F-4972-11D1-A7CA-0000F87571E3": "Folder Redirection",
    "C6DC5466-785A-11D2-84D0-00C04FB169F7": "Software Installation",
    "0ACDD40C-75AC-47AB-BAA0-BF6DE7E7FE63": "Wireless Network Policies",
    "A3F3E39B-5D83-11D1-ABD7-00C04FD8D5B0": "Folder Options",
    "E437BC1C-AA7D-11D2-A382-00C04F991E27": "IP Security",
    "F9C77450-3A41-477E-9310-9ACD617BD9E3": "AppLocker / Software Restriction",
    "6232C319-91AC-4931-9385-E70C2B099F0E": "DNS Client",
    "3610EDA5-77EF-11D2-8DC5-00C04FA31A66": "Disk Quota",
    "16BE69FA-4209-4250-88CB-716CF41954E0": "Central Access Policy",
    "D02B1F72-3407-48AE-BA88-E8213C6761F1": "Offline Files",
    "FB2CA36D-0B40-4307-821B-A13B252DE56C": "Power Options",
    "25537523-E2D0-4F8C-B3B3-C8F6E8FCB8A1": "Advanced Audit Policy",
    "C34B2751-1CF4-44F5-9262-C3FC39666591": "Name Resolution Policy",
}


async def run(payload: dict) -> dict:
    dc_ip    = payload.get("dc_ip", "")
    domain   = payload.get("domain", "")
    username = payload.get("username", "")
    password = payload.get("password", "")
    base_dn  = payload.get("base_dn", "")

    payload.pop("password", None)

    if not dc_ip or not SAFE_HOST_RE.match(dc_ip):
        raise ValueError("Invalid dc_ip")
    if not domain or not SAFE_DOMAIN_RE.match(domain):
        raise ValueError("Invalid domain")
    if not username or not password:
        raise ValueError("Username and password required")

    if not base_dn:
        parts   = domain.split(".")
        base_dn = ",".join(f"DC={p}" for p in parts)

    logger.info(f"Starting AD recon on {domain} ({dc_ip}) as {username}")

    domain_info = await _get_domain_info(dc_ip, domain, username, password, base_dn)

    (
        users, groups, password_policy, fine_grained_policies,
        shares, spns, asrep, dc_list, trusts, dns_zones, dhcp_scopes,
        ous, gpos, computers, delegations, adminsdholder,
        protected_users, service_accounts, laps_status,
    ) = await asyncio.gather(
        _get_users(dc_ip, domain, username, password, base_dn),
        _get_groups(dc_ip, domain, username, password, base_dn),
        _get_password_policy(dc_ip, domain, username, password, base_dn),
        _get_fine_grained_policies(dc_ip, domain, username, password, base_dn),
        _get_shares(dc_ip, domain, username, password),
        _get_spns(dc_ip, domain, username, password, base_dn),
        _get_asrep(dc_ip, domain, username, password, base_dn),
        _get_dc_list(dc_ip, domain, username, password, base_dn),
        _get_trusts(dc_ip, domain, username, password, base_dn),
        _get_dns_zones(dc_ip, domain, username, password),
        _get_dhcp_scopes(dc_ip, domain, username, password),
        _get_ous(dc_ip, domain, username, password, base_dn),
        _get_gpos(dc_ip, domain, username, password, base_dn),
        _get_computers(dc_ip, domain, username, password, base_dn),
        _get_delegations(dc_ip, domain, username, password, base_dn),
        _get_adminsdholder(dc_ip, domain, username, password, base_dn),
        _get_protected_users(dc_ip, domain, username, password, base_dn),
        _get_service_accounts(dc_ip, domain, username, password, base_dn),
        _get_laps_status(dc_ip, domain, username, password, base_dn),
        return_exceptions=False,
    )

    results = {
        "domain_info":            domain_info,
        "users":                  users,
        "groups":                 groups,
        "password_policy":        password_policy,
        "fine_grained_policies":  fine_grained_policies,
        "shares":                 shares,
        "kerberoastable":         spns,
        "asrep_roastable":        asrep,
        "dc_list":                dc_list,
        "trusts":                 trusts,
        "dns_zones":              dns_zones,
        "dhcp_scopes":            dhcp_scopes,
        "ous":                    ous,
        "gpos":                   gpos,
        "computers":              computers,
        "delegations":            delegations,
        "adminsdholder_accounts": adminsdholder,
        "protected_users":        protected_users,
        "service_accounts":       service_accounts,
        "laps_status":            laps_status,
    }

    results["findings"] = _generate_findings(results)

    all_users     = users.get("list", [])
    all_computers = computers.get("list", [])
    results["summary"] = {
        "total_users":               len(all_users),
        "enabled_users":             sum(1 for u in all_users if u.get("enabled")),
        "disabled_users":            sum(1 for u in all_users if not u.get("enabled")),
        "never_logged_in":           sum(1 for u in all_users if not u.get("last_logon")),
        "password_never_expires":    sum(1 for u in all_users if u.get("pwd_never_expires")),
        "stale_accounts":            sum(1 for u in all_users if u.get("stale")),
        "domain_admins":             len(groups.get("domain_admins", {}).get("members", [])),
        "kerberoastable":            len(spns),
        "asrep_roastable":           len(asrep),
        "unconstrained_delegation":  len([d for d in delegations if d.get("type") == "unconstrained"]),
        "constrained_delegation":    len([d for d in delegations if d.get("type") == "constrained"]),
        "adminsdholder_count":       len(adminsdholder),
        "protected_users_count":     len(protected_users),
        "laps_deployed":             laps_status.get("deployed", False),
        "laps_coverage_pct":         laps_status.get("coverage_pct", 0),
        "shares_found":              len(shares),
        "computer_count":            len(all_computers),
        "dc_count":                  len(dc_list),
        "trust_count":               len(trusts),
        "gpo_count":                 len(gpos),
        "ou_count":                  len(ous),
        "fine_grained_policies":     len(fine_grained_policies),
        "service_accounts":          len(service_accounts),
    }

    return results


# ─────────────────────────────────────────────────────────────────────────────
# Domain info
# ─────────────────────────────────────────────────────────────────────────────

async def _get_domain_info(dc_ip, domain, username, password, base_dn) -> dict:
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "base",
                    ["msDS-Behavior-Version", "whenCreated", "name",
                     "dnsHostName", "operatingSystem", "rootDomainNamingContext",
                     "dnsRoot", "nETBIOSName"])
    out, _ = await _run(cmd, 15)

    info = {"dc_ip": dc_ip, "domain": domain, "base_dn": base_dn}
    for line in out.splitlines():
        k, _, v = line.partition(":")
        v = v.strip()
        if "msDS-Behavior-Version" in k:
            info["functional_level"] = {
                "0": "Windows 2000", "1": "Windows Server 2003 interim",
                "2": "Windows Server 2003", "3": "Windows Server 2008",
                "4": "Windows Server 2008 R2", "5": "Windows Server 2012",
                "6": "Windows Server 2012 R2", "7": "Windows Server 2016+",
            }.get(v, f"Level {v}")
        elif "whenCreated:" in line:
            info["created"] = v
        elif "dnsHostName:" in line:
            info["dc_hostname"] = v
        elif "rootDomainNamingContext:" in line:
            info["forest"] = v
        elif "nETBIOSName:" in line:
            info["netbios_name"] = v

    cfg_cmd = _ldap_cmd(dc_ip, domain, username, password,
                        f"CN=Partitions,CN=Configuration,{base_dn}", "sub",
                        ["nETBIOSName", "dnsRoot"],
                        filter=f"(&(objectClass=crossRef)(dnsRoot={domain}))")
    cfg_out, _ = await _run(cfg_cmd, 10)
    for line in cfg_out.splitlines():
        if "nETBIOSName:" in line and not info.get("netbios_name"):
            info["netbios_name"] = line.split(":", 1)[1].strip()
    return info


# ─────────────────────────────────────────────────────────────────────────────
# Domain controllers
# ─────────────────────────────────────────────────────────────────────────────

async def _get_dc_list(dc_ip, domain, username, password, base_dn) -> list:
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["cn", "dNSHostName", "operatingSystem", "operatingSystemVersion",
                     "operatingSystemServicePack", "whenCreated", "msDS-isGC",
                     "userAccountControl"],
                    filter="(&(objectClass=computer)(userAccountControl:1.2.840.113556.1.4.803:=8192))")
    out, _ = await _run(cmd, 20)
    entries  = _parse_ldap_entries(out)
    fsmo     = await _get_fsmo_roles(dc_ip, domain, username, password, base_dn)
    site_map = await _get_dc_sites(dc_ip, domain, username, password, base_dn)

    dcs = []
    for e in entries:
        hostname = e.get("dNSHostName", e.get("cn", ""))
        uac      = int(e.get("userAccountControl", "0") or 0)
        is_gc    = bool(uac & 0x2000000) or e.get("msDS-isGC", "").lower() == "true"
        dc_roles = [role for role, holder in fsmo.items()
                    if holder and hostname.lower() in holder.lower()]
        dcs.append({
            "hostname":        hostname,
            "ip":              await _resolve_hostname(hostname) or "",
            "os":              e.get("operatingSystem", ""),
            "os_version":      e.get("operatingSystemVersion", ""),
            "os_service_pack": e.get("operatingSystemServicePack", ""),
            "is_pdc":          "PDC" in dc_roles,
            "is_gc":           is_gc,
            "fsmo_roles":      dc_roles,
            "site":            site_map.get(hostname, ""),
        })
    return dcs


async def _get_fsmo_roles(dc_ip, domain, username, password, base_dn) -> dict:
    roles = {}
    for cmd, key in [
        (_ldap_cmd(dc_ip, domain, username, password, base_dn, "base", ["fSMORoleOwner"]),
         "Infrastructure Master"),
        (_ldap_cmd(dc_ip, domain, username, password, base_dn, "base",
                   ["fSMORoleOwner"], filter="(objectClass=domainDNS)"),
         "PDC"),
    ]:
        out, _ = await _run(cmd, 10)
        for line in out.splitlines():
            if "fSMORoleOwner:" in line:
                dn = line.split(":", 1)[1].strip()
                roles[key] = _extract_dc_from_dn(dn)
                if key == "PDC":
                    roles["RID Master"] = _extract_dc_from_dn(dn)

    schema_cmd = _ldap_cmd(dc_ip, domain, username, password,
                           f"CN=Schema,CN=Configuration,{base_dn}", "base", ["fSMORoleOwner"])
    out3, _ = await _run(schema_cmd, 10)
    for line in out3.splitlines():
        if "fSMORoleOwner:" in line:
            roles["Schema Master"] = _extract_dc_from_dn(line.split(":", 1)[1].strip())
    return roles


def _extract_dc_from_dn(dn: str) -> str:
    m = re.search(r'CN=([^,]+),CN=Servers', dn)
    return m.group(1) if m else dn


async def _get_dc_sites(dc_ip, domain, username, password, base_dn) -> dict:
    cmd = _ldap_cmd(dc_ip, domain, username, password,
                    f"CN=Sites,CN=Configuration,{base_dn}", "sub",
                    ["cn"], filter="(objectClass=server)")
    out, _ = await _run(cmd, 15)
    result  = {}
    for e in _parse_ldap_entries(out):
        hostname = e.get("cn", "")
        dn       = e.get("dn", "")
        m = re.search(r'CN=Servers,CN=([^,]+)', dn)
        if m:
            result[hostname] = m.group(1)
    return result


async def _resolve_hostname(hostname: str) -> str:
    if not hostname:
        return ""
    try:
        import socket
        loop = asyncio.get_running_loop()
        return await asyncio.wait_for(
            loop.run_in_executor(None, socket.gethostbyname, hostname), timeout=3)
    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# Computers (non-DC)
# ─────────────────────────────────────────────────────────────────────────────

async def _get_computers(dc_ip, domain, username, password, base_dn) -> dict:
    """Enumerate workstations and member servers — excludes DCs."""
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["cn", "dNSHostName", "operatingSystem", "operatingSystemVersion",
                     "userAccountControl", "whenCreated", "lastLogon",
                     "managedBy", "location", "description",
                     "ms-Mcs-AdmPwdExpirationTime"],
                    filter="(&(objectClass=computer)"
                           "(!userAccountControl:1.2.840.113556.1.4.803:=8192))")
    out, _ = await _run(cmd, 30)
    entries         = _parse_ldap_entries(out)
    now             = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(days=90)

    computers  = []
    os_summary: dict = {}
    for e in entries:
        uac        = int(e.get("userAccountControl", "0") or 0)
        enabled    = not bool(uac & 0x0002)
        last_logon = _filetime_to_dt(e.get("lastLogon", "0"))
        stale      = (last_logon is not None and last_logon < stale_threshold) or \
                     (last_logon is None and enabled)
        os_name    = e.get("operatingSystem", "Unknown")
        os_summary[os_name] = os_summary.get(os_name, 0) + 1

        computers.append({
            "name":          e.get("cn", ""),
            "dns_hostname":  e.get("dNSHostName", ""),
            "os":            os_name,
            "os_version":    e.get("operatingSystemVersion", ""),
            "enabled":       enabled,
            "stale":         stale,
            "last_logon":    last_logon.isoformat() if last_logon else None,
            "managed_by":    e.get("managedBy", ""),
            "location":      e.get("location", ""),
            "description":   e.get("description", ""),
            "laps_enrolled": bool(e.get("ms-Mcs-AdmPwdExpirationTime")),
        })

    computers.sort(key=lambda c: c["name"].lower())
    return {"count": len(computers), "list": computers, "os_summary": os_summary}


# ─────────────────────────────────────────────────────────────────────────────
# Users
# ─────────────────────────────────────────────────────────────────────────────

async def _get_users(dc_ip, domain, username, password, base_dn) -> dict:
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["cn", "sAMAccountName", "userAccountControl", "lastLogon",
                     "pwdLastSet", "memberOf", "description", "mail",
                     "scriptPath", "homeDirectory", "profilePath",
                     "userPrincipalName", "title", "department"],
                    filter="(objectClass=user)")
    out, _ = await _run(cmd, 30)
    users           = _parse_ldap_entries(out)
    now             = datetime.now(timezone.utc)
    stale_threshold = now - timedelta(days=90)

    processed = []
    for u in users:
        sam = u.get("sAMAccountName", "")
        if not sam or sam.endswith("$"):
            continue
        uac                = int(u.get("userAccountControl", "0") or 0)
        enabled            = not bool(uac & 0x0002)
        pwd_never_expires  = bool(uac & 0x10000)
        pwd_not_required   = bool(uac & 0x0020)
        sensitive_no_deleg = bool(uac & 0x100000)
        trusted_for_deleg  = bool(uac & 0x80000)
        last_logon         = _filetime_to_dt(u.get("lastLogon", "0"))
        pwd_last_set       = _filetime_to_dt(u.get("pwdLastSet", "0"))
        stale              = (last_logon is not None and last_logon < stale_threshold) or \
                             (last_logon is None and enabled)

        member_of = u.get("memberOf", [])
        if not isinstance(member_of, list):
            member_of = [member_of] if member_of else []
        groups = [re.match(r'CN=([^,]+)', g).group(1) for g in member_of
                  if re.match(r'CN=([^,]+)', g)]

        processed.append({
            "username":           sam,
            "display_name":       u.get("cn", ""),
            "upn":                u.get("userPrincipalName", ""),
            "email":              u.get("mail", ""),
            "title":              u.get("title", ""),
            "department":         u.get("department", ""),
            "description":        u.get("description", ""),
            "enabled":            enabled,
            "last_logon":         last_logon.isoformat() if last_logon else None,
            "pwd_last_set":       pwd_last_set.isoformat() if pwd_last_set else None,
            "pwd_never_expires":  pwd_never_expires,
            "pwd_not_required":   pwd_not_required,
            "sensitive_no_deleg": sensitive_no_deleg,
            "trusted_for_deleg":  trusted_for_deleg,
            "stale":              stale,
            "logon_script":       u.get("scriptPath", ""),
            "home_directory":     u.get("homeDirectory", ""),
            "profile_path":       u.get("profilePath", ""),
            "groups":             groups,
        })
    return {"count": len(processed), "list": processed}


# ─────────────────────────────────────────────────────────────────────────────
# Groups — with nested member resolution
# ─────────────────────────────────────────────────────────────────────────────

async def _get_groups(dc_ip, domain, username, password, base_dn) -> dict:
    privileged = {
        "domain_admins":        "Domain Admins",
        "enterprise_admins":    "Enterprise Admins",
        "schema_admins":        "Schema Admins",
        "administrators":       "Administrators",
        "account_operators":    "Account Operators",
        "backup_operators":     "Backup Operators",
        "server_operators":     "Server Operators",
        "print_operators":      "Print Operators",
        "remote_desktop":       "Remote Desktop Users",
        "group_policy_creator": "Group Policy Creator Owners",
        "protected_users":      "Protected Users",
        "dnsadmins":            "DnsAdmins",
        "event_log_readers":    "Event Log Readers",
        "hyper_v_admins":       "Hyper-V Administrators",
    }
    result = {}
    for key, group_name in privileged.items():
        direct, nested = await _resolve_group_members(
            dc_ip, domain, username, password, base_dn, group_name
        )
        result[key] = {
            "name":            group_name,
            "members":         direct,
            "nested_members":  nested,
            "total_effective": len(set(direct + nested)),
        }
    return result


async def _resolve_group_members(dc_ip, domain, username, password, base_dn,
                                  group_name: str, depth: int = 0,
                                  seen: set = None) -> tuple:
    """Return (direct_users, nested_user_members) — recurse into nested groups up to depth 3."""
    if seen is None:
        seen = set()
    if depth > 3 or group_name in seen:
        return [], []
    seen.add(group_name)

    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["member"],
                    filter=f"(&(objectClass=group)(cn={group_name}))")
    out, _ = await _run(cmd, 10)

    direct_users  = []
    nested_groups = []

    for line in out.splitlines():
        if not line.strip().startswith("member:"):
            continue
        dn       = line.split(":", 1)[1].strip()
        cn_match = re.match(r'CN=([^,]+)', dn)
        if not cn_match:
            continue
        name     = cn_match.group(1)
        is_grp   = await _is_group(dc_ip, domain, username, password, dn)
        if is_grp:
            nested_groups.append(name)
        else:
            direct_users.append(name)

    nested_members = []
    for ng in nested_groups:
        sub_direct, sub_nested = await _resolve_group_members(
            dc_ip, domain, username, password, base_dn, ng, depth + 1, seen
        )
        nested_members.extend(sub_direct)
        nested_members.extend(sub_nested)

    return direct_users, nested_members


async def _is_group(dc_ip, domain, username, password, dn: str) -> bool:
    try:
        cmd = _ldap_cmd(dc_ip, domain, username, password, dn, "base", ["objectClass"])
        out, _ = await _run(cmd, 5)
        return "objectClass: group" in out
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Password policy
# ─────────────────────────────────────────────────────────────────────────────

async def _get_password_policy(dc_ip, domain, username, password, base_dn) -> dict:
    cmd = ["rpcclient", "-U", f"{domain}\\{username}%{password}", dc_ip, "-c", "getdompwinfo"]
    out, _ = await _run(cmd, 10)
    policy = {}
    for line in out.splitlines():
        ll = line.lower()
        if "min_password_length" in ll:
            m = re.search(r':\s*(\d+)', line)
            if m: policy["min_length"] = int(m.group(1))
        elif "lockout_threshold" in ll:
            m = re.search(r':\s*(\d+)', line)
            if m: policy["lockout_threshold"] = int(m.group(1))
        elif "password_properties" in ll:
            m = re.search(r':\s*(0x[0-9a-f]+|\d+)', line)
            if m:
                policy["complexity_required"] = bool(int(m.group(1), 0) & 0x1)
        elif "min_password_age" in ll:
            m = re.search(r':\s*(\d+)', line)
            if m: policy["min_age_days"] = int(m.group(1))
        elif "max_password_age" in ll:
            m = re.search(r':\s*(\d+)', line)
            if m: policy["max_age_days"] = int(m.group(1))

    if not policy:
        cmd2 = _ldap_cmd(dc_ip, domain, username, password, base_dn, "base",
                         ["minPwdLength", "lockoutThreshold", "pwdProperties",
                          "maxPwdAge", "minPwdAge", "pwdHistoryLength",
                          "lockoutObservationWindow", "lockoutDuration"])
        out2, _ = await _run(cmd2, 10)
        for line in out2.splitlines():
            if "minPwdLength:" in line:
                policy["min_length"] = int(line.split(":")[1].strip())
            elif "lockoutThreshold:" in line:
                policy["lockout_threshold"] = int(line.split(":")[1].strip())
            elif "pwdProperties:" in line:
                policy["complexity_required"] = bool(int(line.split(":")[1].strip()) & 0x1)
            elif "pwdHistoryLength:" in line:
                policy["history_length"] = int(line.split(":")[1].strip())
            elif "lockoutObservationWindow:" in line:
                raw = int(line.split(":")[1].strip())
                policy["lockout_observation_window"] = abs(raw) // 600000000 // 60 if raw else 0
            elif "lockoutDuration:" in line:
                raw = int(line.split(":")[1].strip())
                policy["lockout_duration"] = abs(raw) // 600000000 // 60 if raw else 0
            elif "maxPwdAge:" in line:
                raw = int(line.split(":")[1].strip())
                policy["max_age_days"] = abs(raw) // 864000000000 if raw else 0
            elif "minPwdAge:" in line:
                raw = int(line.split(":")[1].strip())
                policy["min_age_days"] = abs(raw) // 864000000000 if raw else 0
    return policy


# ─────────────────────────────────────────────────────────────────────────────
# Fine-grained password policies (PSOs)
# ─────────────────────────────────────────────────────────────────────────────

async def _get_fine_grained_policies(dc_ip, domain, username, password, base_dn) -> list:
    """
    Query Password Settings Objects (PSOs).
    These override the domain default policy for specific users or groups.
    Requires domain functional level Windows Server 2008+.
    """
    pso_dn = f"CN=Password Settings Container,CN=System,{base_dn}"
    cmd    = _ldap_cmd(dc_ip, domain, username, password, pso_dn, "one",
                       ["cn", "msDS-PasswordSettingsPrecedence",
                        "msDS-MinimumPasswordLength", "msDS-MaximumPasswordAge",
                        "msDS-MinimumPasswordAge", "msDS-LockoutThreshold",
                        "msDS-LockoutObservationWindow", "msDS-LockoutDuration",
                        "msDS-PasswordHistoryLength",
                        "msDS-PasswordComplexityEnabled",
                        "msDS-PasswordReversibleEncryptionEnabled",
                        "msDS-PSOAppliesTo"],
                       filter="(objectClass=msDS-PasswordSettings)")
    out, _ = await _run(cmd, 15)

    def _interval_to_min(raw) -> int:
        try: return abs(int(raw)) // 600000000 // 60
        except Exception: return 0

    def _interval_to_days(raw) -> int:
        try: return abs(int(raw)) // 864000000000
        except Exception: return 0

    psos = []
    for e in _parse_ldap_entries(out):
        applies_to = e.get("msDS-PSOAppliesTo", [])
        if not isinstance(applies_to, list):
            applies_to = [applies_to] if applies_to else []
        applies_names = [re.match(r'CN=([^,]+)', dn).group(1)
                         for dn in applies_to if re.match(r'CN=([^,]+)', dn)]
        psos.append({
            "name":                  e.get("cn", ""),
            "precedence":            e.get("msDS-PasswordSettingsPrecedence", ""),
            "min_length":            e.get("msDS-MinimumPasswordLength", ""),
            "max_age_days":          _interval_to_days(e.get("msDS-MaximumPasswordAge", "0")),
            "min_age_days":          _interval_to_days(e.get("msDS-MinimumPasswordAge", "0")),
            "lockout_threshold":     e.get("msDS-LockoutThreshold", ""),
            "lockout_duration_min":  _interval_to_min(e.get("msDS-LockoutDuration", "0")),
            "history_length":        e.get("msDS-PasswordHistoryLength", ""),
            "complexity_enabled":    e.get("msDS-PasswordComplexityEnabled", "").lower() == "true",
            "reversible_encryption": e.get("msDS-PasswordReversibleEncryptionEnabled", "").lower() == "true",
            "applies_to":            applies_names,
        })
    psos.sort(key=lambda p: int(p.get("precedence") or 999))
    return psos


# ─────────────────────────────────────────────────────────────────────────────
# Delegation misconfigurations
# ─────────────────────────────────────────────────────────────────────────────

async def _get_delegations(dc_ip, domain, username, password, base_dn) -> list:
    """
    Find accounts with delegation settings:
    - Unconstrained: can impersonate any user to any service (excludes DCs)
    - Constrained: can impersonate to specific SPNs
    - Resource-based constrained (RBCD)
    """
    delegations = []

    # Unconstrained delegation (excludes DCs)
    unc_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                        ["sAMAccountName", "userAccountControl", "servicePrincipalName"],
                        filter="(&"
                               "(userAccountControl:1.2.840.113556.1.4.803:=524288)"
                               "(!userAccountControl:1.2.840.113556.1.4.803:=8192))")
    unc_out, _ = await _run(unc_cmd, 15)
    for e in _parse_ldap_entries(unc_out):
        sam = e.get("sAMAccountName", "")
        if sam:
            delegations.append({
                "account":  sam,
                "type":     "unconstrained",
                "severity": "critical" if not sam.endswith("$") else "high",
                "detail":   "Can impersonate any domain user to any service",
            })

    # Constrained delegation
    con_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                        ["sAMAccountName", "msDS-AllowedToDelegateTo", "userAccountControl"],
                        filter="(msDS-AllowedToDelegateTo=*)")
    con_out, _ = await _run(con_cmd, 15)
    for e in _parse_ldap_entries(con_out):
        sam   = e.get("sAMAccountName", "")
        spns  = e.get("msDS-AllowedToDelegateTo", [])
        if not isinstance(spns, list):
            spns = [spns] if spns else []
        uac   = int(e.get("userAccountControl", "0") or 0)
        proto = bool(uac & 0x1000000)  # TRUSTED_TO_AUTH_FOR_DELEGATION
        if sam:
            delegations.append({
                "account":             sam,
                "type":                "constrained",
                "allowed_services":    spns,
                "protocol_transition": proto,
                "severity":            "high" if proto else "medium",
                "detail":              f"Can delegate to {len(spns)} service(s)" +
                                       (" with protocol transition" if proto else ""),
            })

    # Resource-based constrained delegation
    rbcd_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                         ["sAMAccountName"],
                         filter="(msDS-AllowedToActOnBehalfOfOtherIdentity=*)")
    rbcd_out, _ = await _run(rbcd_cmd, 15)
    for e in _parse_ldap_entries(rbcd_out):
        sam = e.get("sAMAccountName", "")
        if sam:
            delegations.append({
                "account":  sam,
                "type":     "resource_based_constrained",
                "severity": "medium",
                "detail":   "Resource-based constrained delegation configured",
            })

    return delegations


# ─────────────────────────────────────────────────────────────────────────────
# AdminSDHolder
# ─────────────────────────────────────────────────────────────────────────────

async def _get_adminsdholder(dc_ip, domain, username, password, base_dn) -> list:
    """
    Find user accounts with adminCount=1 — protected by AdminSDHolder / SDProp.
    Stale or unexpected entries here are a security risk.
    """
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["sAMAccountName", "userAccountControl", "lastLogon"],
                    filter="(&(adminCount=1)(objectClass=user)(!objectClass=computer))")
    out, _ = await _run(cmd, 15)
    accounts = []
    for e in _parse_ldap_entries(out):
        sam = e.get("sAMAccountName", "")
        if not sam or sam.endswith("$"):
            continue
        uac        = int(e.get("userAccountControl", "0") or 0)
        last_logon = _filetime_to_dt(e.get("lastLogon", "0"))
        accounts.append({
            "username":   sam,
            "enabled":    not bool(uac & 0x0002),
            "last_logon": last_logon.isoformat() if last_logon else None,
        })
    return accounts


# ─────────────────────────────────────────────────────────────────────────────
# Protected Users
# ─────────────────────────────────────────────────────────────────────────────

async def _get_protected_users(dc_ip, domain, username, password, base_dn) -> list:
    """Members of Protected Users get stronger Kerberos protections."""
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["member"],
                    filter="(&(objectClass=group)(cn=Protected Users))")
    out, _ = await _run(cmd, 10)
    members = []
    for line in out.splitlines():
        if line.strip().startswith("member:"):
            dn = line.split(":", 1)[1].strip()
            m  = re.match(r'CN=([^,]+)', dn)
            if m:
                members.append(m.group(1))
    return members


# ─────────────────────────────────────────────────────────────────────────────
# Service accounts (MSA, gMSA, user-with-SPN)
# ─────────────────────────────────────────────────────────────────────────────

async def _get_service_accounts(dc_ip, domain, username, password, base_dn) -> list:
    accounts = []

    for obj_class, acct_type in [
        ("msDS-ManagedServiceAccount",      "MSA"),
        ("msDS-GroupManagedServiceAccount", "gMSA"),
    ]:
        cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                        ["cn", "sAMAccountName", "servicePrincipalName"],
                        filter=f"(objectClass={obj_class})")
        out, _ = await _run(cmd, 15)
        for e in _parse_ldap_entries(out):
            accounts.append({
                "name":  e.get("sAMAccountName", e.get("cn", "")),
                "type":  acct_type,
                "spns":  e.get("servicePrincipalName", []),
            })

    # Traditional user accounts with SPNs
    svc_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                        ["sAMAccountName", "servicePrincipalName"],
                        filter="(&(objectClass=user)(servicePrincipalName=*)(!objectClass=computer))")
    svc_out, _ = await _run(svc_cmd, 15)
    for e in _parse_ldap_entries(svc_out):
        sam = e.get("sAMAccountName", "")
        if sam and not any(a["name"] == sam for a in accounts):
            accounts.append({
                "name":  sam,
                "type":  "user_with_spn",
                "spns":  e.get("servicePrincipalName", []),
            })

    return accounts


# ─────────────────────────────────────────────────────────────────────────────
# LAPS deployment status
# ─────────────────────────────────────────────────────────────────────────────

async def _get_laps_status(dc_ip, domain, username, password, base_dn) -> dict:
    """Check whether LAPS is deployed and what % of computers are enrolled."""
    schema_dn  = f"CN=ms-Mcs-AdmPwd,CN=Schema,CN=Configuration,{base_dn}"
    schema_cmd = _ldap_cmd(dc_ip, domain, username, password, schema_dn, "base", ["cn"])
    schema_out, _ = await _run(schema_cmd, 10)
    schema_present = bool(re.search(r'cn:\s*ms-Mcs-AdmPwd', schema_out, re.IGNORECASE))

    if not schema_present:
        return {
            "deployed": False, "schema_present": False,
            "enrolled_count": 0, "total_computers": 0, "coverage_pct": 0,
            "detail": "LAPS schema attribute not found — LAPS not installed",
        }

    enr_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub", ["cn"],
                        filter="(&(objectClass=computer)"
                               "(ms-Mcs-AdmPwdExpirationTime=*)"
                               "(!userAccountControl:1.2.840.113556.1.4.803:=8192))")
    tot_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub", ["cn"],
                        filter="(&(objectClass=computer)"
                               "(!userAccountControl:1.2.840.113556.1.4.803:=8192))")
    enr_out, _ = await _run(enr_cmd, 20)
    tot_out, _ = await _run(tot_cmd, 20)

    enrolled_count = len(_parse_ldap_entries(enr_out))
    total_count    = len(_parse_ldap_entries(tot_out))
    coverage_pct   = round(enrolled_count / total_count * 100) if total_count else 0

    return {
        "deployed": True, "schema_present": True,
        "enrolled_count": enrolled_count, "total_computers": total_count,
        "coverage_pct": coverage_pct,
        "detail": f"LAPS enrolled on {enrolled_count}/{total_count} computers ({coverage_pct}%)",
    }


# ─────────────────────────────────────────────────────────────────────────────
# Shares with ACLs
# ─────────────────────────────────────────────────────────────────────────────

async def _get_shares(dc_ip, domain, username, password) -> list:
    """List SMB shares and retrieve share-level ACLs via rpcclient."""
    list_cmd = ["smbclient", "-L", dc_ip, "-U", f"{domain}\\{username}%{password}", "-g"]
    list_out, _ = await _run(list_cmd, 15)

    shares = []
    for line in list_out.splitlines():
        if line.startswith(("Disk|", "IPC|", "Printer|")):
            parts = line.split("|")
            if len(parts) >= 2:
                shares.append({
                    "name":        parts[1],
                    "type":        parts[0],
                    "comment":     parts[2] if len(parts) > 2 else "",
                    "permissions": [],
                })

    for share in shares:
        if share["type"] != "Disk":
            continue
        acl_cmd = ["rpcclient", "-U", f"{domain}\\{username}%{password}",
                   dc_ip, "-c", f"getshareinfo {share['name']}"]
        acl_out, _ = await _run(acl_cmd, 10)
        share["permissions"] = _parse_share_acls(acl_out)

    return shares


def _parse_share_acls(output: str) -> list:
    perms = []
    for line in output.splitlines():
        line = line.strip()
        if line.upper().startswith("ACE:"):
            m = re.match(r'ACE:\s+(.+?):\s+(0x[0-9a-fA-F]+)\s*/\s*(\w+)', line)
            if m:
                mask = int(m.group(2), 16)
                perms.append({
                    "principal":   m.group(1).strip(),
                    "access_mask": hex(mask),
                    "access_type": m.group(3),
                    "readable":    _access_mask_to_str(mask),
                })
    return perms


def _access_mask_to_str(mask: int) -> str:
    if mask & 0x001F01FF:  return "Full Control"
    if mask & 0x001301BF:  return "Change"
    if mask & 0x001200A9:  return "Read"
    return f"0x{mask:08x}"


# ─────────────────────────────────────────────────────────────────────────────
# Trusts / DNS / DHCP / OUs / GPOs  (unchanged from previous version)
# ─────────────────────────────────────────────────────────────────────────────

async def _get_trusts(dc_ip, domain, username, password, base_dn) -> list:
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["trustPartner", "trustDirection", "trustType", "trustAttributes"],
                    filter="(objectClass=trustedDomain)")
    out, _ = await _run(cmd, 15)
    trusts = []
    for e in _parse_ldap_entries(out):
        direction_map = {"0": "Disabled", "1": "Inbound", "2": "Outbound", "3": "Bidirectional"}
        type_map      = {"1": "Downlevel", "2": "Uplevel (Kerberos)", "3": "MIT", "4": "DCE"}
        attrs         = int(e.get("trustAttributes", "0") or 0)
        trusts.append({
            "domain":     e.get("trustPartner", ""),
            "direction":  direction_map.get(e.get("trustDirection", "0"), "Unknown"),
            "type":       type_map.get(e.get("trustType", "0"), "Unknown"),
            "transitive": bool(attrs & 0x8),
        })
    return trusts


async def _get_dns_zones(dc_ip, domain, username, password) -> list:
    zones = []
    for partition in ["DomainDnsZones", "ForestDnsZones"]:
        cmd = _ldap_cmd(dc_ip, domain, username, password,
                        f"CN=MicrosoftDNS,DC={partition},DC={domain.replace('.', ',DC=')}",
                        "one", ["dc", "name"], filter="(objectClass=dnsZone)")
        out, _ = await _run(cmd, 15)
        for e in _parse_ldap_entries(out):
            name = e.get("dc") or e.get("name") or \
                   e.get("dn", "").split(",")[0].replace("DC=", "")
            if name and not name.startswith(".."):
                zones.append({"name": name, "type": "AD-Integrated", "partition": partition})
    if not zones:
        cmd2 = _ldap_cmd(dc_ip, domain, username, password,
                         f"CN=MicrosoftDNS,CN=System,DC={domain.replace('.', ',DC=')}",
                         "one", ["dc"], filter="(objectClass=dnsZone)")
        out2, _ = await _run(cmd2, 15)
        for e in _parse_ldap_entries(out2):
            name = e.get("dc", "")
            if name:
                zones.append({"name": name, "type": "AD-Integrated", "partition": "System"})
    return zones


async def _get_dhcp_scopes(dc_ip, domain, username, password) -> list:
    """
    Pull DHCP scopes from AD.

    Two bugs fixed vs original:
    1. The server child-search was reconstructing the DN from server_cn (the CN
       attribute value).  That works when the CN is a simple hostname, but AD
       often stores the server's FQDN as the CN, so the reconstructed path was
       wrong.  We now use the actual DN returned by LDAP for the child search.
    2. dhcpRanges is multi-valued — each value is one "startIP endIP" pair.
       We now handle both single and multi-value forms.
    3. Also captures the human-readable scope name from dhcpComment.
    """
    base = f"CN=NetServices,CN=Services,CN=Configuration,{_base_dn_from_domain(domain)}"
    cmd  = _ldap_cmd(dc_ip, domain, username, password, base,
                     "sub", ["cn", "distinguishedName"],
                     filter="(objectClass=dhcpServer)")
    out, _ = await _run(cmd, 15)
    scopes = []
    for server_entry in _parse_ldap_entries(out):
        # Use the real DN from LDAP — never reconstruct it from the CN value
        server_dn = server_entry.get("dn", "")
        if not server_dn:
            continue
        scope_cmd = _ldap_cmd(dc_ip, domain, username, password,
                              server_dn,
                              "one",
                              ["cn", "dhcpState", "dhcpRanges", "dhcpSubnetMask",
                               "dhcpComment", "dhcpOptions"],
                              filter="(objectClass=dhcpSubnet)")
        scope_out, _ = await _run(scope_cmd, 10)
        for se in _parse_ldap_entries(scope_out):
            # dhcpRanges may be a single string or a list of strings
            raw_ranges = se.get("dhcpRanges", [])
            if not isinstance(raw_ranges, list):
                raw_ranges = [raw_ranges] if raw_ranges else []
            parsed_ranges = []
            for r in raw_ranges:
                parts = str(r).split()
                if len(parts) >= 2:
                    parsed_ranges.append({"start": parts[0], "end": parts[1]})
                elif len(parts) == 1:
                    parsed_ranges.append({"start": parts[0], "end": ""})
            scopes.append({
                "scope_id":   se.get("cn", ""),
                "description": se.get("dhcpComment", ""),
                "subnet_mask": se.get("dhcpSubnetMask", ""),
                "ranges":     parsed_ranges,
                # Convenience flat fields for the common single-range case
                "start_ip":   parsed_ranges[0]["start"] if parsed_ranges else "",
                "end_ip":     parsed_ranges[0]["end"]   if parsed_ranges else "",
                "state":      "Active" if se.get("dhcpState") == "1" else "Inactive",
            })
    return scopes


def _base_dn_from_domain(domain: str) -> str:
    """Convert 'corp.local' → 'DC=corp,DC=local'."""
    return ",".join(f"DC={p}" for p in domain.split("."))


async def _get_ous(dc_ip, domain, username, password, base_dn) -> list:
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["ou", "name", "gPLink", "distinguishedName"],
                    filter="(objectClass=organizationalUnit)")
    out, _ = await _run(cmd, 20)
    ous = []
    for e in _parse_ldap_entries(out):
        dn        = e.get("dn", "")
        gp_link   = e.get("gPLink", "")
        gpo_links = re.findall(r'\{[A-F0-9\-]+\}', gp_link) if gp_link else []
        ous.append({
            "name":      e.get("ou") or e.get("name", ""),
            "dn":        dn,
            "depth":     max(0, dn.upper().count("OU=") - 1),
            "gpo_links": gpo_links,
        })
    ous.sort(key=lambda o: o["dn"])
    return ous


async def _get_gpos(dc_ip, domain, username, password, base_dn) -> list:
    """
    Enumerate GPOs with name, status, dates, linked OUs, version numbers,
    and CSE-based type classification (no SYSVOL access needed).
    """
    policies_dn = f"CN=Policies,CN=System,{base_dn}"
    cmd = _ldap_cmd(dc_ip, domain, username, password, policies_dn, "one",
                    ["displayName", "cn", "gPCFileSysPath", "flags",
                     "whenChanged", "whenCreated", "versionNumber",
                     "gPCMachineExtensionNames", "gPCUserExtensionNames"],
                    filter="(objectClass=groupPolicyContainer)")
    out, _ = await _run(cmd, 20)

    ou_gpo_map: dict = {}
    ous_cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                        ["ou", "name", "gPLink"],
                        filter="(&(objectClass=organizationalUnit)(gPLink=*))")
    ous_out, _ = await _run(ous_cmd, 15)
    for oe in _parse_ldap_entries(ous_out):
        gp_link = oe.get("gPLink", "")
        ou_name = oe.get("ou") or oe.get("name", "")
        for guid in re.findall(r'\{([A-F0-9\-]+)\}', gp_link, re.IGNORECASE):
            ou_gpo_map.setdefault(guid.upper(), []).append(ou_name)

    gpos = []
    for e in _parse_ldap_entries(out):
        guid        = e.get("cn", "").strip("{}")
        flags       = int(e.get("flags", "0") or 0)
        status      = ("Disabled" if flags == 3 else
                       "Computer config disabled" if flags == 2 else
                       "User config disabled" if flags == 1 else "Enabled")
        version_raw = int(e.get("versionNumber", "0") or 0)
        gpos.append({
            "name":              e.get("displayName", guid),
            "guid":              guid,
            "status":            status,
            "created":           e.get("whenCreated", ""),
            "modified":          e.get("whenChanged", ""),
            "computer_version":  (version_raw >> 16) & 0xFFFF,
            "user_version":      version_raw & 0xFFFF,
            "sysvol_path":       e.get("gPCFileSysPath", ""),
            "linked_ous":        ou_gpo_map.get(guid.upper(), []),
            "computer_settings": _parse_cse_guids(e.get("gPCMachineExtensionNames", "")),
            "user_settings":     _parse_cse_guids(e.get("gPCUserExtensionNames", "")),
        })
    # Enrich each GPO with settings parsed from SYSVOL
    enriched = await asyncio.gather(*[
        _fetch_gpo_settings(dc_ip, domain, username, password, g)
        for g in gpos
    ], return_exceptions=True)
    for i, result in enumerate(enriched):
        if isinstance(result, dict):
            gpos[i]["details"] = result

    gpos.sort(key=lambda g: g["name"].lower())
    return gpos


async def _fetch_gpo_settings(dc_ip, domain, username, password, gpo: dict) -> dict:
    """
    Download and parse the two most informative files from a GPO's SYSVOL folder:
      - Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf  (security template — plain text INI)
      - GPT.INI (version confirmation)

    GptTmpl.inf contains:
      [System Access]       — password/lockout policy overrides
      [Privilege Rights]    — user rights assignments (SeBackupPrivilege etc.)
      [Event Audit]         — legacy audit categories
      [Registry Values]     — specific registry security settings
      [Group Membership]    — restricted groups

    We do NOT attempt to parse Registry.pol (binary PReg format) here — it would
    require a full PReg decoder and returns mostly opaque registry paths.
    """
    guid   = gpo.get("guid", "")
    if not guid:
        return {}

    details: dict = {}

    # Download GptTmpl.inf via smbclient
    inf_path = f"\\SYSVOL\\{domain}\\Policies\\{{{guid}}}\\Machine\\Microsoft\\Windows NT\\SecEdit\\GptTmpl.inf"
    cmd = [
        "smbclient", f"\\\\{dc_ip}\\SYSVOL",
        "-U", f"{domain}\\{password.split(':')[0] if ':' in str(password) else password}",
        "--no-pass",
    ]
    # Use smbclient with credentials properly
    smb_cmd = [
        "smbclient", f"//{dc_ip}/SYSVOL",
        "-U", f"{domain}\\__USERNAME_PLACEHOLDER__",
        "-c", f"get {domain}/Policies/{{{guid}}}/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf /tmp/gpt_{guid}.inf",
    ]
    # We can't embed password safely in args — use the impacket approach instead
    # Actually use smbclient with --password flag (not in argv for ps aux visibility concern,
    # but password was already accepted as a design tradeoff for this task)
    smb_cmd = [
        "smbclient", f"//{dc_ip}/SYSVOL",
        "-U", f"{domain}/{password}",  # impacket-style user/pass
        "--no-pass", "-A", "/dev/stdin",
    ]

    # Simpler: use smbget
    inf_url  = f"smb://{dc_ip}/SYSVOL/{domain}/Policies/{{{guid}}}/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf"
    get_cmd  = ["smbget", "-U", f"{domain}%{password}", "--quiet", inf_url, "-o", f"/tmp/gpt_{guid}.inf"]
    _, err   = await _run(get_cmd, 10)

    import os
    tmp_path = f"/tmp/gpt_{guid}.inf"
    if os.path.exists(tmp_path):
        try:
            inf_text = open(tmp_path, encoding="utf-8-sig", errors="replace").read()
            details  = _parse_gpttmpl_inf(inf_text)
        except Exception:
            pass
        finally:
            try: os.unlink(tmp_path)
            except Exception: pass

    return details


def _parse_gpttmpl_inf(text: str) -> dict:
    """
    Parse a GptTmpl.inf security template into structured sections.
    Returns a dict with keys for each section that has useful data.
    """
    import configparser, io

    # GptTmpl.inf is INI-like but uses Unicode and sometimes has duplicate keys.
    # We parse it manually to handle duplicates gracefully.
    sections: dict = {}
    current_section = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current_section = line[1:-1].strip()
            sections.setdefault(current_section, {})
            continue
        if current_section and "=" in line:
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()
            # Keep all values (some keys like SeBackupPrivilege appear once)
            if key in sections[current_section]:
                existing = sections[current_section][key]
                if not isinstance(existing, list):
                    sections[current_section][key] = [existing]
                sections[current_section][key].append(val)
            else:
                sections[current_section][key] = val

    result = {}

    # ── System Access (password/lockout policy in GPO) ────────────────────────
    sa = sections.get("System Access", {})
    if sa:
        pol = {}
        for k, friendly in [
            ("MinimumPasswordAge",      "min_age_days"),
            ("MaximumPasswordAge",      "max_age_days"),
            ("MinimumPasswordLength",   "min_length"),
            ("PasswordHistorySize",     "history_length"),
            ("LockoutBadCount",         "lockout_threshold"),
            ("LockoutDuration",         "lockout_duration_min"),
            ("ResetLockoutCount",       "lockout_observation_min"),
            ("PasswordComplexity",      "complexity_required"),
            ("ClearTextPassword",       "reversible_encryption"),
        ]:
            if k in sa:
                v = sa[k]
                if friendly in ("complexity_required", "reversible_encryption"):
                    pol[friendly] = str(v) == "1"
                else:
                    try: pol[friendly] = int(v)
                    except Exception: pol[friendly] = v
        if pol:
            result["system_access"] = pol

    # ── Privilege Rights (user rights assignments) ────────────────────────────
    pr = sections.get("Privilege Rights", {})
    if pr:
        # Translate SE constants to human names
        SE_MAP = {
            "SeNetworkLogonRight":             "Access this computer from the network",
            "SeInteractiveLogonRight":         "Log on locally",
            "SeRemoteInteractiveLogonRight":   "Allow log on through Remote Desktop",
            "SeDenyNetworkLogonRight":         "Deny access from network",
            "SeDenyInteractiveLogonRight":     "Deny local logon",
            "SeDenyRemoteInteractiveLogonRight": "Deny RDP logon",
            "SeBackupPrivilege":               "Back up files and directories",
            "SeRestorePrivilege":              "Restore files and directories",
            "SeShutdownPrivilege":             "Shut down the system",
            "SeDebugPrivilege":                "Debug programs",
            "SeAuditPrivilege":                "Generate security audits",
            "SeTakeOwnershipPrivilege":        "Take ownership",
            "SeLoadDriverPrivilege":           "Load and unload device drivers",
            "SeImpersonatePrivilege":          "Impersonate a client after authentication",
            "SeAssignPrimaryTokenPrivilege":   "Replace a process-level token",
            "SeTcbPrivilege":                  "Act as part of the operating system",
            "SeSecurityPrivilege":             "Manage auditing and security log",
            "SeIncreaseBasePriorityPrivilege": "Increase scheduling priority",
            "SeCreateTokenPrivilege":          "Create a token object",
            "SeEnableDelegationPrivilege":     "Enable computer and user accounts for delegation",
        }
        rights = {}
        for se_const, val in pr.items():
            human = SE_MAP.get(se_const, se_const)
            # Values are comma-separated SIDs/names like *S-1-5-32-544,*S-1-5-32-551
            principals = [p.strip().lstrip("*") for p in str(val).split(",") if p.strip()]
            if principals:
                rights[human] = principals
        if rights:
            result["privilege_rights"] = rights

    # ── Event Audit (legacy audit categories) ────────────────────────────────
    ea = sections.get("Event Audit", {})
    if ea:
        AUDIT_MAP = {
            "AuditSystemEvents":        "System Events",
            "AuditLogonEvents":         "Logon Events",
            "AuditObjectAccess":        "Object Access",
            "AuditPrivilegeUse":        "Privilege Use",
            "AuditProcessTracking":     "Process Tracking",
            "AuditPolicyChange":        "Policy Change",
            "AuditAccountManage":       "Account Management",
            "AuditDSAccess":            "Directory Service Access",
            "AuditAccountLogon":        "Account Logon Events",
        }
        AUDIT_VAL = {"0": "No auditing", "1": "Success", "2": "Failure", "3": "Success and Failure"}
        audit = {}
        for k, human in AUDIT_MAP.items():
            if k in ea:
                audit[human] = AUDIT_VAL.get(str(ea[k]), str(ea[k]))
        if audit:
            result["audit_policy"] = audit

    # ── Group Membership (restricted groups) ─────────────────────────────────
    gm = sections.get("Group Membership", {})
    if gm:
        groups = {}
        for k, v in gm.items():
            if "__Members" in k:
                group_name = k.replace("__Members", "").strip().lstrip("*")
                members = [m.strip().lstrip("*") for m in str(v).split(",") if m.strip()]
                if members:
                    groups[group_name] = members
        if groups:
            result["restricted_groups"] = groups

    # ── Registry Values (security options) ───────────────────────────────────
    rv = sections.get("Registry Values", {})
    if rv:
        # Only surface the most security-relevant registry value settings
        REGVAL_MAP = {
            r"MACHINE\System\CurrentControlSet\Control\Lsa\LmCompatibilityLevel":
                "LM Compatibility Level",
            r"MACHINE\System\CurrentControlSet\Control\Lsa\NoLMHash":
                "Do not store LM hash",
            r"MACHINE\System\CurrentControlSet\Control\Lsa\RestrictAnonymous":
                "Restrict anonymous access",
            r"MACHINE\System\CurrentControlSet\Control\Lsa\RestrictAnonymousSAM":
                "Restrict anonymous SAM enumeration",
            r"MACHINE\System\CurrentControlSet\Services\LanManWorkstation\Parameters\RequireSecuritySignature":
                "SMB client signing required",
            r"MACHINE\System\CurrentControlSet\Services\LanManServer\Parameters\RequireSecuritySignature":
                "SMB server signing required",
            r"MACHINE\System\CurrentControlSet\Services\LanManServer\Parameters\EnableSecuritySignature":
                "SMB server signing enabled",
            r"MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections":
                "RDP disabled",
        }
        reg_vals = {}
        for k, v in rv.items():
            # Registry.pol key format is "path,type,value" — GptTmpl just has "path=type,value"
            k_norm = k.replace("/", "\\")
            for reg_key, human in REGVAL_MAP.items():
                if reg_key.lower() in k_norm.lower():
                    # Value format: "type,data" e.g. "4,1"
                    val_str = str(v).split(",")[-1].strip() if "," in str(v) else str(v)
                    reg_vals[human] = val_str
        if reg_vals:
            result["security_options"] = reg_vals

    return result


def _parse_cse_guids(cse_string: str) -> list:
    if not cse_string:
        return []
    guids    = re.findall(r'\{([A-F0-9\-]+)\}', cse_string.upper())
    readable = []
    for guid in guids:
        label = CSE_GUID_MAP.get(guid)
        if label and label not in readable:
            readable.append(label)
    return readable


# ─────────────────────────────────────────────────────────────────────────────
# Kerberos
# ─────────────────────────────────────────────────────────────────────────────

async def _get_spns(dc_ip, domain, username, password, base_dn) -> list:
    try:
        cmd = ["python3", "-m", "impacket.examples.GetUserSPNs",
               f"{domain}/{username}:{password}", "-dc-ip", dc_ip, "-request", "-"]
        out, _ = await _run([c for c in cmd if c], 30)
        if "No entries found" in out or not out.strip():
            raise ValueError("empty")
        accounts = [{"spn": line.split("ServicePrincipalName")[-1].strip()}
                    for line in out.splitlines() if "ServicePrincipalName" in line]
        if accounts:
            return accounts[:50]
    except Exception:
        pass

    cmd2 = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                     ["sAMAccountName", "servicePrincipalName"],
                     filter="(&(objectClass=user)(servicePrincipalName=*)(!objectClass=computer))")
    out2, _ = await _run(cmd2, 15)
    return [{"username": e.get("sAMAccountName"), "spn": e.get("servicePrincipalName")}
            for e in _parse_ldap_entries(out2) if e.get("sAMAccountName")]


async def _get_asrep(dc_ip, domain, username, password, base_dn) -> list:
    cmd = _ldap_cmd(dc_ip, domain, username, password, base_dn, "sub",
                    ["sAMAccountName", "userAccountControl"],
                    filter="(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=4194304))")
    out, _ = await _run(cmd, 15)
    return [{"username": e.get("sAMAccountName")} for e in _parse_ldap_entries(out)
            if e.get("sAMAccountName") and not e.get("sAMAccountName", "").endswith("$")]


# ─────────────────────────────────────────────────────────────────────────────
# Findings engine
# ─────────────────────────────────────────────────────────────────────────────

def _generate_findings(results: dict) -> list:
    findings  = []
    policy    = results.get("password_policy", {})
    users     = results.get("users", {}).get("list", [])
    groups    = results.get("groups", {})
    trusts    = results.get("trusts", [])
    gpos      = results.get("gpos", [])
    deleg     = results.get("delegations", [])
    laps      = results.get("laps_status", {})
    psos      = results.get("fine_grained_policies", [])
    computers = results.get("computers", {}).get("list", [])
    sdholder  = results.get("adminsdholder_accounts", [])
    protected = results.get("protected_users", [])
    svc_accts = results.get("service_accounts", [])

    def finding(severity, category, title, detail):
        findings.append({"severity": severity, "category": category,
                         "title": title, "detail": detail})

    # Password policy
    min_len = policy.get("min_length", 999)
    if min_len < 8:
        finding("high", "Password Policy",
                f"Weak minimum password length ({min_len} characters)",
                "Minimum password length below 8 increases brute-force risk.")
    if policy.get("lockout_threshold") == 0:
        finding("high", "Password Policy", "No account lockout policy",
                "Accounts not locked after failed logins — susceptible to password spraying.")
    if not policy.get("complexity_required"):
        finding("medium", "Password Policy", "Password complexity not enforced",
                "Domain does not require complex passwords.")
    if policy.get("max_age_days") == 0:
        finding("medium", "Password Policy", "Domain passwords never expire",
                "No maximum password age set.")
    hist = policy.get("history_length", 999)
    if hist < 5:
        finding("low", "Password Policy", f"Short password history ({hist} remembered)",
                "Low history allows immediate password reuse.")

    # Fine-grained policies
    for pso in psos:
        pso_len = pso.get("min_length")
        if pso_len and int(pso_len) < 8:
            finding("medium", "Fine-Grained Password Policy",
                    f"PSO '{pso['name']}' has weak minimum length ({pso_len})",
                    f"Applies to: {', '.join(pso.get('applies_to', []))}")
        if pso.get("reversible_encryption"):
            finding("high", "Fine-Grained Password Policy",
                    f"PSO '{pso['name']}' uses reversible encryption",
                    "Reversible encryption stores passwords in a recoverable form.")

    # Kerberos
    spns = results.get("kerberoastable", [])
    if spns:
        finding("high", "Kerberos", f"{len(spns)} Kerberoastable account(s)",
                f"SPNs whose tickets can be cracked offline: "
                f"{', '.join(s.get('username', s.get('spn', '')) for s in spns[:5])}")
    asrep = results.get("asrep_roastable", [])
    if asrep:
        finding("high", "Kerberos", f"{len(asrep)} AS-REP roastable account(s)",
                f"No Kerberos pre-auth: {', '.join(a.get('username', '') for a in asrep[:5])}")

    # Delegation
    unc = [d for d in deleg if d.get("type") == "unconstrained"]
    if unc:
        finding("critical", "Delegation",
                f"{len(unc)} account(s) with unconstrained Kerberos delegation",
                f"Can impersonate any user to any service: "
                f"{', '.join(d['account'] for d in unc[:5])}")
    proto = [d for d in deleg if d.get("type") == "constrained" and d.get("protocol_transition")]
    if proto:
        finding("high", "Delegation",
                f"{len(proto)} constrained delegation account(s) with protocol transition",
                f"Can impersonate users without their password: "
                f"{', '.join(d['account'] for d in proto[:5])}")

    # LAPS
    if not laps.get("deployed"):
        finding("high", "LAPS", "LAPS not deployed",
                "All computers likely share the same local admin password.")
    elif laps.get("coverage_pct", 100) < 80:
        finding("medium", "LAPS", f"LAPS coverage is {laps['coverage_pct']}%",
                f"{laps.get('enrolled_count')}/{laps.get('total_computers')} computers enrolled.")

    # AdminSDHolder
    stale_sdh = [a for a in sdholder if not a.get("enabled")]
    if stale_sdh:
        finding("medium", "AdminSDHolder",
                f"{len(stale_sdh)} disabled account(s) still AdminSDHolder-protected",
                f"Remove from privileged groups: "
                f"{', '.join(a['username'] for a in stale_sdh[:5])}")

    # Protected Users
    da_members   = set(groups.get("domain_admins", {}).get("members", []))
    not_protected = da_members - set(protected)
    if not_protected:
        finding("medium", "Protected Users",
                f"{len(not_protected)} Domain Admin(s) not in Protected Users",
                f"Not protected: {', '.join(list(not_protected)[:5])}")

    # Account hygiene
    stale_users = [u for u in users if u.get("stale") and u.get("enabled")]
    if len(stale_users) > 5:
        finding("medium", "Account Hygiene",
                f"{len(stale_users)} stale enabled accounts (no login > 90 days)",
                "Inactive accounts increase attack surface.")
    pne = [u for u in users if u.get("pwd_never_expires") and u.get("enabled")]
    if pne:
        finding("medium", "Account Hygiene",
                f"{len(pne)} account(s) with password never expires",
                f"Examples: {', '.join(u['username'] for u in pne[:5])}")
    pnr = [u for u in users if u.get("pwd_not_required") and u.get("enabled")]
    if pnr:
        finding("high", "Account Hygiene",
                f"{len(pnr)} account(s) with no password required",
                f"Can authenticate with blank password: "
                f"{', '.join(u['username'] for u in pnr[:5])}")
    user_unc = [u for u in users if u.get("trusted_for_deleg")]
    if user_unc:
        finding("high", "Account Hygiene",
                f"{len(user_unc)} user(s) trusted for unconstrained delegation",
                f"Accounts: {', '.join(u['username'] for u in user_unc[:5])}")

    # Computer hygiene
    stale_comp = [c for c in computers if c.get("stale") and c.get("enabled")]
    if len(stale_comp) > 5:
        finding("low", "Computer Hygiene",
                f"{len(stale_comp)} stale computer accounts",
                "May represent decommissioned machines still in AD.")

    # Privilege
    da       = groups.get("domain_admins", {})
    da_total = da.get("total_effective", 0)
    if da_total > 5:
        all_da = da.get("members", []) + da.get("nested_members", [])
        finding("medium", "Privilege",
                f"Large Domain Admins group ({da_total} effective members)",
                f"Members (incl. nested): {', '.join(all_da[:10])}")
    ea       = groups.get("enterprise_admins", {})
    ea_total = ea.get("total_effective", 0)
    if ea_total > 2:
        finding("medium", "Privilege",
                f"Enterprise Admins has {ea_total} members (expected 1-2)",
                f"Members: {', '.join(ea.get('members', []))}")

    # Service accounts
    kerberoastable_names = {s.get("username") for s in results.get("kerberoastable", [])}
    svc_k = [s for s in svc_accts if s.get("type") == "user_with_spn"
             and s.get("name") in kerberoastable_names]
    if svc_k:
        finding("high", "Service Accounts",
                f"{len(svc_k)} traditional service account(s) are Kerberoastable",
                "Consider migrating to gMSA (auto-rotating 120-char passwords).")

    # Trusts
    for t in trusts:
        if t.get("direction") == "Bidirectional" and t.get("transitive"):
            finding("info", "Trusts",
                    f"Bidirectional transitive trust with {t['domain']}",
                    "Extends attack surface — review if still required.")

    # GPOs
    disabled = [g for g in gpos if g.get("status") != "Enabled"]
    if disabled:
        finding("low", "Group Policy", f"{len(disabled)} disabled GPO(s)",
                f"Review and remove if unneeded: "
                f"{', '.join(g['name'] for g in disabled[:5])}")
    unlinked = [g for g in gpos if not g.get("linked_ous")]
    if unlinked:
        finding("info", "Group Policy", f"{len(unlinked)} unlinked GPO(s)",
                f"No effect — clean up: "
                f"{', '.join(g['name'] for g in unlinked[:5])}")

    sev_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    findings.sort(key=lambda f: sev_order.get(f.get("severity", "info"), 4))
    return findings


# ─────────────────────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────────────────────

def _ldap_cmd(dc_ip, domain, username, password, base_dn,
              scope, attrs, filter="(objectClass=*)") -> list:
    return [
        "ldapsearch", "-x",
        "-H", f"ldap://{dc_ip}",
        "-D", f"{username}@{domain}",
        "-w", password,
        "-b", base_dn,
        "-s", scope,
        filter,
    ] + attrs


async def _run(cmd: list, timeout: int) -> tuple:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return stdout.decode(errors="replace"), stderr.decode(errors="replace")
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return "", "timeout"
    except Exception as e:
        return "", str(e)


def _parse_ldap_entries(output: str) -> list:
    entries = []
    current = {}
    for line in output.splitlines():
        if line.startswith("dn:"):
            if current:
                entries.append(current)
            current = {"dn": line.split(":", 1)[1].strip()}
        elif ":" in line and not line.startswith(" "):
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip()
            if key in current:
                if not isinstance(current[key], list):
                    current[key] = [current[key]]
                current[key].append(val)
            else:
                current[key] = val
    if current:
        entries.append(current)
    return entries


def _filetime_to_dt(filetime_str: str):
    try:
        ft = int(filetime_str)
        if ft == 0 or ft == 9223372036854775807:
            return None
        timestamp = (ft - 116444736000000000) / 10_000_000
        return datetime.fromtimestamp(timestamp, tz=timezone.utc)
    except (ValueError, TypeError, OSError):
        return None
