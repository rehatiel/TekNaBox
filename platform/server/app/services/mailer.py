"""
Email alert service — thin wrapper around stdlib smtplib.
Runs blocking SMTP calls in a thread executor so async workers stay non-blocking.
SMTP is only attempted when SMTP_HOST is set in config.
"""

import asyncio
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()


def _send_sync(to: str, subject: str, body_html: str) -> None:
    s = _settings
    if not s.smtp_host:
        logger.warning("alert_email_skipped: SMTP_HOST not configured")
        return

    sender = s.smtp_from or s.smtp_user or "noreply@teknabox"
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to
    msg.attach(MIMEText(body_html, "html"))

    try:
        if s.smtp_tls:
            # SSL on port 465
            with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port or 465) as smtp:
                if s.smtp_user and s.smtp_password:
                    smtp.login(s.smtp_user, s.smtp_password)
                smtp.sendmail(sender, [to], msg.as_string())
        else:
            # STARTTLS on port 587
            with smtplib.SMTP(s.smtp_host, s.smtp_port or 587) as smtp:
                smtp.ehlo()
                smtp.starttls()
                if s.smtp_user and s.smtp_password:
                    smtp.login(s.smtp_user, s.smtp_password)
                smtp.sendmail(sender, [to], msg.as_string())

        logger.info(f"alert_email_sent to={to} subject={subject!r}")
    except Exception as e:
        logger.error(f"alert_email_failed: {e}")


async def send_alert_email(to: str, subject: str, body_html: str) -> None:
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _send_sync, to, subject, body_html)


# ── HTML templates ─────────────────────────────────────────────────────────────

def _wrap(body: str) -> str:
    return f"""
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;color:#1e293b;background:#f8fafc;padding:24px">
  <div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
    <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #e2e8f0">
      <strong style="color:#0891b2;font-size:18px">TekNaBox</strong>
    </div>
    {body}
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
      This is an automated alert from your TekNaBox RMM platform.
    </div>
  </div>
</body>
</html>"""


async def send_offline_alert(to: str, devices: list[dict]) -> None:
    rows = "".join(
        f"<tr><td style='padding:6px 8px;border-bottom:1px solid #f1f5f9'>"
        f"<strong>{d['name']}</strong></td>"
        f"<td style='padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#64748b'>"
        f"{d.get('customer_name') or ''}</td>"
        f"<td style='padding:6px 8px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:12px;color:#94a3b8'>"
        f"{d.get('last_ip') or '—'}</td></tr>"
        for d in devices
    )
    count = len(devices)
    noun = "device has" if count == 1 else "devices have"
    body = f"""
<h2 style="margin:0 0 12px;color:#dc2626">{count} Device{'' if count==1 else 's'} Offline</h2>
<p style="color:#475569">{count} {noun} lost connection to the TekNaBox platform:</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
  <thead>
    <tr style="background:#f8fafc;font-size:12px;color:#64748b">
      <th style="padding:6px 8px;text-align:left">Device</th>
      <th style="padding:6px 8px;text-align:left">Customer</th>
      <th style="padding:6px 8px;text-align:left">Last IP</th>
    </tr>
  </thead>
  <tbody>{rows}</tbody>
</table>"""
    await send_alert_email(to, f"[TekNaBox] {count} device{'' if count==1 else 's'} offline", _wrap(body))


async def send_findings_alert(to: str, findings: list[dict]) -> None:
    SEV_COLOR = {"critical": "#dc2626", "high": "#ea580c", "medium": "#d97706", "low": "#2563eb"}
    rows = "".join(
        "<tr>"
        "<td style='padding:6px 8px;border-bottom:1px solid #f1f5f9'>"
        "<span style='color:{color};font-weight:600;text-transform:uppercase;font-size:11px'>{sev}</span></td>"
        "<td style='padding:6px 8px;border-bottom:1px solid #f1f5f9'>{title}</td>"
        "<td style='padding:6px 8px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:12px;color:#94a3b8'>{dev}</td>"
        "</tr>".format(
            color=SEV_COLOR.get(finding["severity"], "#64748b"),
            sev=finding["severity"],
            title=finding["title"],
            dev=(finding.get("device_name") or finding.get("device_id", "")[:8]),
        )
        for finding in findings
    )
    count = len(findings)
    body = f"""
<h2 style="margin:0 0 12px;color:#dc2626">New Security Findings</h2>
<p style="color:#475569">{count} new finding{'' if count==1 else 's'} detected on your platform:</p>
<table style="width:100%;border-collapse:collapse;margin:16px 0">
  <thead>
    <tr style="background:#f8fafc;font-size:12px;color:#64748b">
      <th style="padding:6px 8px;text-align:left">Severity</th>
      <th style="padding:6px 8px;text-align:left">Finding</th>
      <th style="padding:6px 8px;text-align:left">Device</th>
    </tr>
  </thead>
  <tbody>{rows}</tbody>
</table>"""
    await send_alert_email(to, f"[TekNaBox] {count} new security finding{'' if count==1 else 's'}", _wrap(body))


async def send_monitor_alert(to: str, monitor, direction: str) -> None:
    """Send a monitor down or recovery alert."""
    name   = monitor.name
    target = monitor.target
    mon_type = str(monitor.type).upper()

    if direction == "down":
        subject = f"[TekNaBox] Monitor DOWN — {name}"
        color   = "#dc2626"
        heading = f"&#x1F534; {name} is DOWN"
        detail  = f"<p style='color:#475569'><strong>{mon_type}</strong> check for <code>{target}</code> has failed {monitor.consecutive_failures} consecutive time(s).</p>"
        if monitor.last_rtt_ms is None:
            detail += f"<p style='color:#dc2626'>Error: {monitor.last_status or 'unreachable'}</p>"
    else:
        subject = f"[TekNaBox] Monitor UP — {name}"
        color   = "#16a34a"
        heading = f"&#x1F7E2; {name} has RECOVERED"
        detail  = f"<p style='color:#475569'><strong>{mon_type}</strong> check for <code>{target}</code> is back up.</p>"
        if monitor.last_rtt_ms is not None:
            detail += f"<p style='color:#475569'>Response time: <strong>{monitor.last_rtt_ms:.1f}ms</strong></p>"

    body = f"""
<h2 style="margin:0 0 12px;color:{color}">{heading}</h2>
{detail}
<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
  <tr><td style="padding:4px 8px;color:#64748b;width:120px">Monitor</td><td style="padding:4px 8px">{name}</td></tr>
  <tr><td style="padding:4px 8px;color:#64748b">Type</td><td style="padding:4px 8px">{mon_type}</td></tr>
  <tr><td style="padding:4px 8px;color:#64748b">Target</td><td style="padding:4px 8px"><code>{target}</code></td></tr>
</table>"""
    await send_alert_email(to, subject, _wrap(body))


async def send_test_alert(to: str) -> None:
    body = """
<h2 style="margin:0 0 12px;color:#0891b2">Alert Test Successful</h2>
<p style="color:#475569">Your TekNaBox alert configuration is working correctly.</p>
<p style="color:#475569">You will receive alerts at this address when:</p>
<ul style="color:#475569">
  <li>A monitored device goes offline</li>
  <li>New critical or high security findings are detected</li>
</ul>"""
    await send_alert_email(to, "[TekNaBox] Alert configuration test", _wrap(body))
