"""
Message dispatcher.
Routes inbound server messages to the appropriate handler.
Returns the response message to send back, or None.
"""

import asyncio
import logging
import time
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionManager
    from core.config import AgentConfig

logger = logging.getLogger(__name__)

# Task type → handler module mapping
TASK_HANDLERS = {
    # ── System ────────────────────────────────────────────────────────────────
    "get_sysinfo":              "tasks.sysinfo",
    "run_speedtest":            "tasks.speedtest",

    # ── Network discovery ─────────────────────────────────────────────────────
    "run_ping_sweep":           "tasks.ping_sweep",
    "run_arp_scan":             "tasks.arp_scan",
    "run_nmap_scan":            "tasks.nmap_scan",
    "run_port_scan":            "tasks.port_scan",
    "run_netbios_scan":         "tasks.netbios_scan",
    "run_lldp_neighbors":       "tasks.lldp_neighbors",
    "run_wireless_survey":      "tasks.wireless_survey",
    "run_wol":                  "tasks.wol",

    # ── Diagnostics ───────────────────────────────────────────────────────────
    "run_dns_lookup":           "tasks.dns_lookup",
    "run_traceroute":           "tasks.traceroute",
    "run_mtr":                  "tasks.mtr_report",
    "run_iperf":                "tasks.iperf_test",
    "run_banner_grab":          "tasks.banner_grab",
    "run_packet_capture":       "tasks.packet_capture",
    "run_http_monitor":         "tasks.http_monitor",
    "run_ntp_check":            "tasks.ntp_check",

    # ── SNMP ──────────────────────────────────────────────────────────────────
    "run_snmp_query":           "tasks.snmp_query",

    # ── Security & compliance ─────────────────────────────────────────────────
    "run_vlan_hop":             "tasks.vlan_hop",
    "run_ssl_check":            "tasks.ssl_check",
    "run_dns_health":           "tasks.dns_health",
    "run_vuln_scan":            "tasks.vuln_scan",
    "run_security_audit":       "tasks.security_audit",
    "run_default_creds":        "tasks.default_creds",
    "run_cleartext_services":   "tasks.cleartext_services",

    # ── SMB ───────────────────────────────────────────────────────────────────
    "run_smb_enum":             "tasks.smb_enum",

    # ── Network fingerprinting ────────────────────────────────────────────────
    "run_device_fingerprint":   "tasks.device_fingerprint",

    # ── Active Directory ──────────────────────────────────────────────────────
    "run_ad_discover":          "tasks.ad_discover",
    "run_ad_recon":             "tasks.ad_recon",

    # ── Prospecting ───────────────────────────────────────────────────────────
    "run_email_breach":         "tasks.email_breach",
}


async def dispatch(
    msg: dict,
    config: "AgentConfig",
    manager: "ConnectionManager",
) -> Optional[dict]:
    msg_type = msg.get("type")

    if msg_type == "task":
        return await _handle_task(msg, config, manager)
    elif msg_type == "update_available":
        from core.updater import handle_update_available
        asyncio.create_task(handle_update_available(msg, config, manager))
        return None
    elif msg_type == "config_update":
        return await _handle_config_update(msg, config)
    elif msg_type == "monitor_config":
        from core.monitor import update_monitor_config
        targets  = msg.get("targets", [])
        interval = msg.get("interval", 30)
        await update_monitor_config(targets, interval)
        return None

    elif msg_type == "net_watch_config":
        from core.net_watcher import update_net_watch_config
        await update_net_watch_config(msg)
        return None

    return None


# Pre-import cache — populated on first use per task type
_MODULE_CACHE: dict = {}


def _get_task_module(handler_module: str):
    """Return cached module, importing once on first call."""
    if handler_module not in _MODULE_CACHE:
        import importlib
        _MODULE_CACHE[handler_module] = importlib.import_module(handler_module)
    return _MODULE_CACHE[handler_module]


async def _handle_task(
    msg: dict,
    config: "AgentConfig",
    manager: "ConnectionManager",
) -> dict:
    task_id   = msg.get("id")
    task_type = msg.get("task_type")
    payload   = msg.get("payload", {})
    timeout   = msg.get("timeout_seconds", 300)

    logger.info(f"task_received task_type={task_type} id={task_id}")

    handler_module = TASK_HANDLERS.get(task_type)
    if not handler_module:
        logger.warning(f"task_unknown task_type={task_type}")
        return {
            "type":    "task_result",
            "id":      task_id,
            "success": False,
            "error":   f"Unknown task type: {task_type}",
        }

    try:
        mod = _get_task_module(handler_module)
        start = time.time()

        result = await asyncio.wait_for(mod.run(payload), timeout=timeout)
        duration_ms           = int((time.time() - start) * 1000)
        result["duration_ms"] = duration_ms

        logger.info(f"task_completed task_type={task_type} id={task_id} duration_ms={duration_ms}")
        return {
            "type":    "task_result",
            "id":      task_id,
            "success": True,
            "result":  result,
        }

    except asyncio.TimeoutError:
        logger.error(f"task_timeout task_type={task_type} id={task_id} timeout_s={timeout}")
        return {
            "type":    "task_result",
            "id":      task_id,
            "success": False,
            "error":   f"Task timed out after {timeout}s",
        }
    except Exception as e:
        logger.error(f"task_failed task_type={task_type} id={task_id} error={e}", exc_info=True)
        return {
            "type":    "task_result",
            "id":      task_id,
            "success": False,
            "error":   str(e),
        }


_CONFIG_SCHEMA = {
    "heartbeat_interval": (int,   lambda v: max(5, min(v, 3600))),
    "log_level":          (str,   lambda v: v.upper() if v.upper() in ("DEBUG","INFO","WARNING","ERROR") else "INFO"),
    "reconnect_min":      (float, lambda v: max(1.0, min(v, 60.0))),
    "reconnect_max":      (float, lambda v: max(60.0, min(v, 3600.0))),
}

async def _handle_config_update(msg: dict, config: "AgentConfig") -> Optional[dict]:
    from core.config import save_config
    changes = msg.get("config", {})
    applied = {}
    for key, value in changes.items():
        schema = _CONFIG_SCHEMA.get(key)
        if not schema:
            continue
        cast, clamp = schema
        try:
            coerced = clamp(cast(value))
            setattr(config, key, coerced)
            applied[key] = coerced
        except (ValueError, TypeError) as e:
            logger.warning(f"config_update_rejected key={key} value={value!r} reason={e}")
    if applied:
        save_config(config)
        logger.info(f"Config updated: {applied}")
    return None
