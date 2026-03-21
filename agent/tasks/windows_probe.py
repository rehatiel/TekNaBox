"""
Task: run_windows_probe

Payload:
  target:   IP or hostname of the Windows machine (required)
  username: local admin or domain user — NOT stored after task (required)
  password: password — NOT stored after task (required)
  port:     WinRM port (default 5985 for HTTP, 5986 for HTTPS)
  use_ssl:  use HTTPS/port 5986 (default False)

Agentless Windows inventory and security posture check via WinRM/PowerShell.
No software installed on the target — requires WinRM to be enabled.

WinRM is on by default on Server editions. For workstations:
  winrm quickconfig -quiet

Collects:
  - OS version, hostname, domain membership, uptime, architecture
  - CPU, RAM, disk utilisation per drive
  - Key running services (Defender, WinRM, Spooler, RDP, etc.)
  - Local users and local Administrators group members
  - Installed software (registry-based — fast, no WMI Win32_Product)
  - Network adapters and IPv4 addresses
  - Recent hotfixes (last patch date)
  - Firewall status per profile (domain/private/public)
  - RDP enabled + Network Level Authentication requirement
  - SMBv1 enabled/disabled
  - Windows Defender status and signature age
  - UAC enabled/disabled
  - AutoLogon registry key

Auto-generates security findings for detected issues.
Credentials are used only during execution and are never persisted.
"""

import asyncio
import json
import logging
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')

# OS versions past end-of-life
EOL_OS_PATTERNS = [
    'Windows XP', 'Windows Vista', 'Windows 7', 'Windows 8 ',
    'Windows Server 2003', 'Windows Server 2008 ', 'Windows Server 2012 ',
]

# ── PowerShell collection script ───────────────────────────────────────────────
# Runs on the remote host over WinRM. Each section uses try/catch so a single
# permission error doesn't abort the whole probe. Returns compressed JSON.

# Split into two scripts to stay under the Windows ~8191-char command line limit.
# pywinrm base64-encodes scripts as UTF-16LE before passing via -EncodedCommand,
# which roughly triples the character count. Each part must stay under ~2800 chars.

# Part 1: system info, disks, network, security settings
_PS_PART1 = r"""
$e='SilentlyContinue'
$r=@{}
try{$o=Get-CimInstance Win32_OperatingSystem;$c=Get-CimInstance Win32_ComputerSystem;$p=Get-CimInstance Win32_Processor|Select-Object -First 1;$r.hostname=$env:COMPUTERNAME;$r.os_caption=$o.Caption;$r.os_version=$o.Version;$r.os_build=$o.BuildNumber;$r.architecture=$o.OSArchitecture;$r.domain=$c.Domain;$r.domain_joined=($c.PartOfDomain -eq $true);$r.total_ram_gb=[math]::Round($c.TotalPhysicalMemory/1GB,2);$r.free_ram_gb=[math]::Round($o.FreePhysicalMemory/1MB,2);$r.ram_pct=[math]::Round((1-$o.FreePhysicalMemory*1KB/$c.TotalPhysicalMemory)*100,1);$r.uptime_seconds=[int]((Get-Date)-$o.LastBootUpTime).TotalSeconds;$r.cpu_name=$p.Name.Trim();$r.cpu_cores=$p.NumberOfCores;$r.last_boot=$o.LastBootUpTime.ToUniversalTime().ToString('o')}catch{$r.system_error=$_.Exception.Message}
try{$r.disks=@(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"|ForEach-Object{@{drive=$_.DeviceID;label=$_.VolumeName;total_gb=[math]::Round($_.Size/1GB,2);free_gb=[math]::Round($_.FreeSpace/1GB,2);used_pct=if($_.Size-gt 0){[math]::Round((1-$_.FreeSpace/$_.Size)*100,1)}else{0}}})}catch{$r.disks=@()}
try{$r.adapters=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop|Where-Object{$_.IPAddress -ne '127.0.0.1'}|ForEach-Object{@{adapter=$_.InterfaceAlias;ip=$_.IPAddress;prefix=$_.PrefixLength}})}catch{$r.adapters=@()}
try{$fw=Get-NetFirewallProfile -ErrorAction Stop;$r.firewall=@{};$fw|ForEach-Object{$r.firewall[$_.Name]=($_.Enabled -eq $true)}}catch{$r.firewall=$null}
try{$k=Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -EA Stop;$r.rdp_enabled=($k.fDenyTSConnections -eq 0)}catch{$r.rdp_enabled=$null}
try{$k=Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -EA Stop;$r.rdp_nla=($k.UserAuthenticationRequired -eq 1)}catch{$r.rdp_nla=$null}
try{$s=Get-SmbServerConfiguration -EA Stop;$r.smb_v1=$s.EnableSMB1Protocol}catch{try{$k=Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters' -EA Stop;$r.smb_v1=($k.SMB1 -ne 0)}catch{$r.smb_v1=$null}}
try{$k=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -EA Stop;$r.uac_enabled=($k.EnableLUA -eq 1)}catch{$r.uac_enabled=$null}
try{$k=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -EA Stop;$r.autologon_user=$k.DefaultUserName;$r.autologon_enabled=($k.AutoAdminLogon -eq '1')}catch{$r.autologon_user=$null;$r.autologon_enabled=$false}
$r|ConvertTo-Json -Depth 5 -Compress
""".strip()

# Part 2: services, users, admins, hotfixes, defender, installed software
_PS_PART2 = r"""
$e='SilentlyContinue'
$r=@{}
try{$sv=@('WinDefend','wuauserv','BITS','RemoteRegistry','W32Time','MpsSvc','WinRM','LanmanServer','LanmanWorkstation','Spooler','RpcSs','EventLog','TermService','Netlogon','Schedule');$r.services=@(Get-Service -EA Stop|Where-Object{$sv -contains $_.Name}|ForEach-Object{@{name=$_.Name;display=$_.DisplayName;status=$_.Status.ToString();start_type=$_.StartType.ToString()}})}catch{$r.services=@()}
try{$r.local_users=@(Get-LocalUser|ForEach-Object{@{name=$_.Name;enabled=$_.Enabled;password_expires=($_.PasswordExpires -ne $null);last_logon=if($_.LastLogon){$_.LastLogon.ToUniversalTime().ToString('o')}else{$null}}})}catch{$r.local_users=@()}
try{$ag=[ADSI]"WinNT://./Administrators,group";$r.local_admins=@($ag.Members()|ForEach-Object{$_.GetType().InvokeMember('Name','GetProperty',$null,$_,$null)})}catch{$r.local_admins=@()}
try{$hf=Get-HotFix|Sort-Object InstalledOn -Descending;$lt=$hf|Select-Object -First 1;$r.hotfix_count=$hf.Count;$r.last_hotfix_date=if($lt -and $lt.InstalledOn){$lt.InstalledOn.ToUniversalTime().ToString('o')}else{$null};$r.last_hotfix_kb=if($lt){$lt.HotFixID}else{$null}}catch{$r.hotfix_count=0;$r.last_hotfix_date=$null;$r.last_hotfix_kb=$null}
try{$d=Get-MpComputerStatus -EA Stop;$r.defender_enabled=$d.AntivirusEnabled;$r.defender_rtp=$d.RealTimeProtectionEnabled;$r.defender_sig_age=$d.AntivirusSignatureAge}catch{$r.defender_enabled=$null;$r.defender_rtp=$null;$r.defender_sig_age=$null}
try{$p=@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*');$r.installed_software=@(Get-ItemProperty $p -EA SilentlyContinue|Where-Object{$_.DisplayName -and $_.DisplayName.Trim() -ne ''}|Sort-Object DisplayName|Select-Object -First 200|ForEach-Object{@{name=$_.DisplayName;version=$_.DisplayVersion;publisher=$_.Publisher;install_date=$_.InstallDate}})}catch{$r.installed_software=@()}
$r|ConvertTo-Json -Depth 5 -Compress
""".strip()


# ── Synchronous WinRM call (runs in thread executor) ──────────────────────────

def _ps(session, script: str) -> dict:
    """Run a PowerShell script and return parsed JSON. Raises on failure."""
    result = session.run_ps(script)
    if result.status_code != 0:
        stderr = result.std_err.decode('utf-8', errors='replace').strip()
        raise RuntimeError(f"PowerShell exited {result.status_code}: {stderr[:400]}")
    raw = result.std_out.decode('utf-8', errors='replace').strip()
    if not raw:
        raise RuntimeError("PowerShell returned empty output — check WinRM access and credentials")
    return json.loads(raw)


def _run_sync(target: str, username: str, password: str, port: int, use_ssl: bool) -> dict:
    import winrm  # type: ignore  # optional dependency

    protocol = 'https' if use_ssl else 'http'
    endpoint = f'{protocol}://{target}:{port}/wsman'

    session = winrm.Session(
        endpoint,
        auth=(username, password),
        transport='ntlm',
        server_cert_validation='ignore',   # self-signed certs are common on Windows
    )

    part1 = _ps(session, _PS_PART1)
    part2 = _ps(session, _PS_PART2)
    return {**part1, **part2}


# ── Finding generation ────────────────────────────────────────────────────────

def _generate_findings(data: dict, target: str) -> list[dict]:
    findings = []

    def f(severity, title, detail, cve=None):
        entry = {"severity": severity, "title": title, "detail": detail, "ip": target}
        if cve:
            entry["cve"] = cve
        return entry

    # SMBv1 — EternalBlue / WannaCry
    if data.get("smb_v1") is True:
        findings.append(f(
            "critical", "SMBv1 Protocol Enabled",
            "SMBv1 is enabled. This legacy protocol was exploited by EternalBlue/WannaCry. "
            "Disable: Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force",
            cve="CVE-2017-0144",
        ))

    # Firewall off per profile
    for profile, enabled in (data.get("firewall") or {}).items():
        if enabled is False:
            findings.append(f(
                "critical", f"Windows Firewall Disabled ({profile} Profile)",
                f"The Windows Firewall is disabled for the {profile} network profile. "
                "Re-enable: Set-NetFirewallProfile -Profile {profile} -Enabled True",
            ))

    # AutoLogon with plaintext password in registry
    if data.get("autologon_enabled"):
        findings.append(f(
            "high", "AutoLogon Configured",
            f"Automatic logon is enabled for user '{data.get('autologon_user', 'unknown')}'. "
            "The password may be recoverable from HKLM\\...\\Winlogon. "
            "Disable AutoAdminLogon unless explicitly required.",
        ))

    # RDP without NLA
    if data.get("rdp_enabled") and data.get("rdp_nla") is False:
        findings.append(f(
            "high", "RDP Enabled Without Network Level Authentication",
            "Remote Desktop is accessible without NLA, allowing pre-authentication attacks. "
            "Enable NLA: System Properties → Remote → require NLA.",
        ))

    # Defender disabled
    if data.get("defender_enabled") is False:
        findings.append(f(
            "high", "Windows Defender Antivirus Disabled",
            "Windows Defender is not active. Ensure an alternative AV solution is running, "
            "or re-enable Defender via Windows Security settings.",
        ))
    elif data.get("defender_rtp") is False:
        findings.append(f(
            "medium", "Windows Defender Real-Time Protection Disabled",
            "Defender is installed but real-time protection is turned off. "
            "Enable it in Windows Security → Virus & threat protection.",
        ))

    # Stale AV signatures
    sig_age = data.get("defender_sig_age")
    if sig_age is not None and sig_age > 7:
        findings.append(f(
            "medium", f"Defender Signatures {sig_age} Days Old",
            "Antivirus definitions are stale. Update immediately via Windows Update "
            "or: Update-MpSignature",
        ))

    # UAC disabled
    if data.get("uac_enabled") is False:
        findings.append(f(
            "medium", "User Account Control (UAC) Disabled",
            "UAC is disabled. Any process running as the logged-in user can silently "
            "elevate to full administrator without a prompt.",
        ))

    # EOL operating system
    os_caption = data.get("os_caption", "")
    for pattern in EOL_OS_PATTERNS:
        if pattern in os_caption:
            findings.append(f(
                "medium", "End-of-Life Operating System",
                f"'{os_caption}' is past end-of-life and no longer receives security patches. "
                "Upgrade to a supported Windows version.",
            ))
            break

    # No Windows Updates in >90 days
    last_hotfix = data.get("last_hotfix_date")
    if last_hotfix:
        try:
            last_dt = datetime.fromisoformat(last_hotfix.replace('Z', '+00:00'))
            age = (datetime.now(timezone.utc) - last_dt).days
            if age > 90:
                findings.append(f(
                    "medium", f"No Windows Updates in {age} Days",
                    f"The last installed hotfix was {age} days ago ({data.get('last_hotfix_kb', '?')}). "
                    "Apply pending updates via Windows Update or WSUS.",
                ))
        except Exception:
            pass

    # Excessive local admins
    admins = data.get("local_admins") or []
    if len(admins) > 3:
        sample = ", ".join(str(a) for a in admins[:6])
        if len(admins) > 6:
            sample += f" and {len(admins) - 6} more"
        findings.append(f(
            "low", f"Excessive Local Administrators ({len(admins)})",
            f"Local Administrators group has {len(admins)} members: {sample}. "
            "Minimise local admin membership to reduce lateral movement risk.",
        ))

    # Guest account enabled
    for user in (data.get("local_users") or []):
        if user.get("name", "").lower() == "guest" and user.get("enabled"):
            findings.append(f(
                "low", "Guest Account Enabled",
                "The built-in Guest account is enabled. Disable it: "
                "Disable-LocalUser -Name Guest",
            ))
            break

    return findings


# ── Entry point ───────────────────────────────────────────────────────────────

async def run(payload: dict) -> dict:
    target   = payload.get("target", "").strip()
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    port     = int(payload.get("port") or 5985)
    use_ssl  = bool(payload.get("use_ssl", False))

    if not target:
        return {"error": "target is required"}
    if not username:
        return {"error": "username is required"}
    if not password:
        return {"error": "password is required"}
    if not SAFE_HOST_RE.match(target):
        return {"error": "invalid target — use an IP address or simple hostname"}

    try:
        loop = asyncio.get_event_loop()
        data = await loop.run_in_executor(
            None, _run_sync, target, username, password, port, use_ssl
        )
    except ImportError:
        return {"error": "pywinrm is not installed — run: pip3 install pywinrm"}
    except Exception as e:
        return {"error": str(e), "target": target}

    data["target"]   = target
    data["findings"] = _generate_findings(data, target)
    return data
