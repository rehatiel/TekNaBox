"""
Webhook alert service — POSTs JSON payloads to a configured URL.
Uses httpx (already a dependency) for async HTTP.
Compatible with Slack incoming webhooks, n8n, Zapier, Make, custom endpoints, etc.
"""

import logging
import httpx

logger = logging.getLogger(__name__)

_TIMEOUT = 10  # seconds


async def _post(url: str, payload: dict) -> None:
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
        logger.info(f"webhook_sent url={url!r} status={resp.status_code}")
    except Exception as e:
        logger.error(f"webhook_failed url={url!r} error={e}")


async def send_offline_webhook(url: str, devices: list[dict]) -> None:
    await _post(url, {
        "event": "devices_offline",
        "count": len(devices),
        "devices": [
            {"name": d["name"], "last_ip": d.get("last_ip")}
            for d in devices
        ],
        # Slack-compatible fallback text
        "text": f"[TekNaBox] {len(devices)} device{'s' if len(devices) != 1 else ''} went offline: "
                + ", ".join(d["name"] for d in devices[:5])
                + (" …" if len(devices) > 5 else ""),
    })


async def send_findings_webhook(url: str, findings: list[dict]) -> None:
    await _post(url, {
        "event": "new_findings",
        "count": len(findings),
        "findings": [
            {"severity": f["severity"], "title": f["title"], "device_id": f.get("device_id")}
            for f in findings
        ],
        "text": f"[TekNaBox] {len(findings)} new security finding{'s' if len(findings) != 1 else ''} detected: "
                + ", ".join(f"{f['severity'].upper()} — {f['title']}" for f in findings[:3])
                + (" …" if len(findings) > 3 else ""),
    })


async def send_test_webhook(url: str) -> None:
    await _post(url, {
        "event": "test",
        "text": "[TekNaBox] Webhook test successful — your alert configuration is working correctly.",
    })
