"""
Background workers:
- Task timeout watchdog
- Device heartbeat monitor
- Update scheduler
All intervals and timeouts are driven by settings from config/env.
"""

import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select, and_, update as sql_update
from sqlalchemy.orm import joinedload

from app.core.config import get_settings
from app.core.database import AsyncSessionLocal
from app.models.models import (
    Device, DeviceStatus, Task, TaskStatus,
    DeviceUpdateJob, UpdateStatus, ClientRelease,
    AlertConfig, ScanFinding, FindingSeverity,
)
from app.services.update_service import notify_device_of_update
from app.services.mailer import send_offline_alert, send_findings_alert
from app.services.webhooker import send_offline_webhook, send_findings_webhook

logger = logging.getLogger(__name__)
settings = get_settings()


async def task_timeout_watchdog():
    """Mark overdue tasks as TIMEOUT."""
    while True:
        await asyncio.sleep(settings.task_watchdog_interval)
        try:
            async with AsyncSessionLocal() as db:
                now = datetime.now(timezone.utc)
                result = await db.execute(
                    select(Task).where(
                        Task.status.in_([TaskStatus.DISPATCHED, TaskStatus.RUNNING])
                    )
                )
                tasks = result.scalars().all()
                timed_out = []
                for task in tasks:
                    deadline = task.dispatched_at or task.queued_at
                    if deadline and (now - deadline).total_seconds() > (
                        task.timeout_seconds + settings.task_timeout_grace_seconds
                    ):
                        task.status = TaskStatus.TIMEOUT
                        task.completed_at = now
                        timed_out.append(task.id)
                if timed_out:
                    await db.commit()
                    logger.info(f"tasks_timed_out count={len(timed_out)}")
        except Exception as e:
            logger.error(f"task_watchdog_error: {e}")


async def heartbeat_monitor():
    """Mark devices OFFLINE if not seen within heartbeat timeout. Send alert emails."""
    while True:
        await asyncio.sleep(settings.heartbeat_monitor_interval)
        try:
            async with AsyncSessionLocal() as db:
                cutoff = datetime.now(timezone.utc) - timedelta(
                    seconds=settings.device_heartbeat_timeout
                )
                result = await db.execute(
                    sql_update(Device)
                    .where(
                        and_(
                            Device.status == DeviceStatus.ACTIVE,
                            Device.last_seen_at.isnot(None),
                            Device.last_seen_at < cutoff,
                        )
                    )
                    .values(status=DeviceStatus.OFFLINE)
                    .returning(Device.id, Device.name, Device.last_ip, Device.msp_id)
                )
                gone_offline = result.fetchall()
                await db.commit()

                if not gone_offline:
                    continue

                logger.info(f"devices_marked_offline count={len(gone_offline)}")

                # Group by MSP and send alert emails
                from collections import defaultdict
                by_msp: dict[str, list] = defaultdict(list)
                for row in gone_offline:
                    by_msp[row.msp_id].append({"name": row.name, "last_ip": row.last_ip})

                for msp_id, devices in by_msp.items():
                    cfg_result = await db.execute(
                        select(AlertConfig).where(AlertConfig.msp_id == msp_id)
                    )
                    cfg = cfg_result.scalar_one_or_none()
                    if cfg and cfg.notify_offline:
                        if cfg.alert_email:
                            await send_offline_alert(cfg.alert_email, devices)
                        if cfg.webhook_url:
                            await send_offline_webhook(cfg.webhook_url, devices)

        except Exception as e:
            logger.error(f"heartbeat_monitor_error: {e}")


async def update_scheduler():
    """Re-notify connected devices of pending updates."""
    from app.services.connection_manager import connected_device_ids
    while True:
        await asyncio.sleep(settings.update_scheduler_interval)
        try:
            async with AsyncSessionLocal() as db:
                connected = set(connected_device_ids())
                if not connected:
                    continue

                result = await db.execute(
                    select(DeviceUpdateJob)
                    .options(joinedload(DeviceUpdateJob.release))
                    .where(
                        and_(
                            DeviceUpdateJob.status.in_([
                                UpdateStatus.PENDING, UpdateStatus.NOTIFIED
                            ]),
                            DeviceUpdateJob.device_id.in_(list(connected)),
                        )
                    )
                )
                jobs = result.unique().scalars().all()
                for job in jobs:
                    release = job.release
                    if release and release.is_active:
                        await notify_device_of_update(job.device_id, release, job.id)
                        job.status = UpdateStatus.NOTIFIED
                        job.notified_at = datetime.now(timezone.utc)
                await db.commit()
        except Exception as e:
            logger.error(f"update_scheduler_error: {e}")



async def findings_alerter():
    """
    Every 5 minutes: check for new critical/high findings since last alert.
    Sends a digest email per MSP if new findings exist and notify is enabled.
    """
    while True:
        await asyncio.sleep(300)
        try:
            async with AsyncSessionLocal() as db:
                configs_result = await db.execute(
                    select(AlertConfig).where(
                        and_(
                            (AlertConfig.alert_email.isnot(None) | AlertConfig.webhook_url.isnot(None)),
                            (AlertConfig.notify_critical_findings == True) |  # noqa: E712
                            (AlertConfig.notify_high_findings == True),       # noqa: E712
                        )
                    )
                )
                configs = configs_result.scalars().all()

                for cfg in configs:
                    cutoff = cfg.last_finding_alert_at or (
                        datetime.now(timezone.utc) - timedelta(minutes=5)
                    )
                    severity_filter = []
                    if cfg.notify_critical_findings:
                        severity_filter.append(FindingSeverity.CRITICAL)
                    if cfg.notify_high_findings:
                        severity_filter.append(FindingSeverity.HIGH)

                    findings_result = await db.execute(
                        select(ScanFinding).where(
                            and_(
                                ScanFinding.msp_id == cfg.msp_id,
                                ScanFinding.severity.in_(severity_filter),
                                ScanFinding.found_at > cutoff,
                                ScanFinding.acknowledged == False,  # noqa: E712
                            )
                        ).order_by(ScanFinding.found_at.desc()).limit(20)
                    )
                    findings = findings_result.scalars().all()

                    if findings:
                        payload = [
                            {"severity": f.severity.value, "title": f.title, "device_id": f.device_id}
                            for f in findings
                        ]
                        if cfg.alert_email:
                            await send_findings_alert(cfg.alert_email, payload)
                        if cfg.webhook_url:
                            await send_findings_webhook(cfg.webhook_url, payload)

                    cfg.last_finding_alert_at = datetime.now(timezone.utc)

                if configs:
                    await db.commit()

        except Exception as e:
            logger.error(f"findings_alerter_error: {e}")


async def main():
    logging.basicConfig(level=logging.INFO)
    logger.info(
        f"workers_starting — heartbeat_timeout={settings.device_heartbeat_timeout}s "
        f"monitor_interval={settings.heartbeat_monitor_interval}s "
        f"task_watchdog_interval={settings.task_watchdog_interval}s"
    )
    await asyncio.gather(
        task_timeout_watchdog(),
        heartbeat_monitor(),
        update_scheduler(),
        findings_alerter(),
    )


if __name__ == "__main__":
    asyncio.run(main())
