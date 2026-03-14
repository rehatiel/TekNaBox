# MSP Agent tasks
# Explicit imports ensure all task modules are discoverable at startup.
# If you add a new task module, register it here AND in core/dispatcher.py.

from tasks import (  # noqa: F401
    # System
    sysinfo, speedtest,
    # Network discovery
    ping_sweep, arp_scan, nmap_scan, port_scan,
    netbios_scan, lldp_neighbors, wireless_survey, wol,
    # Diagnostics
    dns_lookup, traceroute, mtr_report, iperf_test,
    banner_grab, packet_capture, http_monitor, ntp_check,
    # SNMP
    snmp_query,
    # Security & compliance
    ssl_check, dns_health, vuln_scan, security_audit,
    default_creds, cleartext_services,
    # SMB
    smb_enum,
    # Active Directory
    ad_discover, ad_recon,
    # Prospecting
    email_breach,
)

__all__ = [
    "sysinfo", "speedtest",
    "ping_sweep", "arp_scan", "nmap_scan", "port_scan",
    "netbios_scan", "lldp_neighbors", "wireless_survey", "wol",
    "dns_lookup", "traceroute", "mtr_report", "iperf_test",
    "banner_grab", "packet_capture", "http_monitor", "ntp_check",
    "snmp_query",
    "ssl_check", "dns_health", "vuln_scan", "security_audit",
    "default_creds", "cleartext_services",
    "smb_enum",
    "ad_discover", "ad_recon",
    "email_breach",
]
