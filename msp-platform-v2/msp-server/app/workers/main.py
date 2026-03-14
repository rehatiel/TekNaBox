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

from app.core.config import get_settings
from app.core.database import AsyncSessionLocal
from app.models.models import (
    Device, DeviceStatus, Task, TaskStatus,
    DeviceUpdateJob, UpdateStatus, ClientRelease,
)
from app.services.update_service import notify_device_of_update

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
    """Mark devices OFFLINE if not seen within heartbeat timeout."""
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
                    .returning(Device.id)
                )
                gone_offline = result.fetchall()
                await db.commit()
                if gone_offline:
                    logger.info(f"devices_marked_offline count={len(gone_offline)}")
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
                    select(DeviceUpdateJob).where(
                        and_(
                            DeviceUpdateJob.status.in_([
                                UpdateStatus.PENDING, UpdateStatus.NOTIFIED
                            ]),
                            DeviceUpdateJob.device_id.in_(list(connected)),
                        )
                    )
                )
                jobs = result.scalars().all()
                for job in jobs:
                    release_result = await db.execute(
                        select(ClientRelease).where(
                            and_(
                                ClientRelease.id == job.release_id,
                                ClientRelease.is_active == True,
                            )
                        )
                    )
                    release = release_result.scalar_one_or_none()
                    if release:
                        await notify_device_of_update(job.device_id, release, job.id)
                        job.status = UpdateStatus.NOTIFIED
                        job.notified_at = datetime.now(timezone.utc)
                await db.commit()
        except Exception as e:
            logger.error(f"update_scheduler_error: {e}")


async def wan_uptime_monitor():
    """
    Server-side WAN monitor.
    Pings each active device's last known IP every 60s and records UptimeCheck.
    """
    import re

    async def ping_host(host: str) -> tuple[bool, float | None]:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ping", "-c", "1", "-W", "3", host,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            if proc.returncode == 0:
                m = re.search(r'time=([\d.]+)', stdout.decode())
                rtt = float(m.group(1)) if m else None
                return True, rtt
        except Exception:
            pass
        return False, None

    while True:
        await asyncio.sleep(60)
        try:
            async with AsyncSessionLocal() as db:
                from app.models.models import UptimeCheck
                result = await db.execute(
                    select(Device).where(
                        and_(
                            Device.status.in_([DeviceStatus.ACTIVE, DeviceStatus.OFFLINE]),
                            Device.last_ip.isnot(None),
                        )
                    )
                )
                devices = result.scalars().all()

                for device in devices:
                    success, rtt = await ping_host(device.last_ip)
                    check = UptimeCheck(
                        device_id=device.id,
                        msp_id=device.msp_id,
                        target=device.last_ip,
                        source="wan",
                        success=success,
                        rtt_ms=rtt,
                        packet_loss_pct=0.0 if success else 100.0,
                        checked_at=datetime.now(timezone.utc),
                    )
                    db.add(check)

                await db.commit()
                if devices:
                    logger.debug(f"wan_monitor: checked {len(devices)} devices")

        except Exception as e:
            logger.error(f"wan_uptime_monitor_error: {e}")


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
        wan_uptime_monitor(),
    )


if __name__ == "__main__":
    asyncio.run(main())
