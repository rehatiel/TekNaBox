"""
Update orchestration service.

Responsible for:
- Evaluating which devices are eligible for a given release
- Creating DeviceUpdateJob records
- Notifying connected devices via WebSocket
- Tracking update state transitions
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    ClientRelease, Device, DeviceStatus, DeviceUpdateJob, UpdatePolicy,
    UpdateStatus, AuditAction,
)
from app.services.audit import write_audit
from app.services import connection_manager as cm

logger = logging.getLogger(__name__)


def _version_lt(a: str, b: str) -> bool:
    """Simple semver comparison a < b."""
    def parts(v):
        return [int(x) for x in v.split(".")[:3]]
    try:
        return parts(a) < parts(b)
    except Exception:
        return False


async def evaluate_rollout(
    db: AsyncSession,
    release: ClientRelease,
    msp_id: str,
    operator_id: Optional[str] = None,
) -> list[str]:
    """
    Determine which devices should receive this release based on UpdatePolicy.
    Creates DeviceUpdateJob rows for eligible devices.
    Returns list of device IDs scheduled.
    """
    # Gather active policies for this release
    policy_result = await db.execute(
        select(UpdatePolicy).where(
            and_(
                UpdatePolicy.release_id == release.id,
                UpdatePolicy.msp_id == msp_id,
                UpdatePolicy.is_active,
            )
        )
    )
    policies = policy_result.scalars().all()

    # Build device query from policies
    device_filters = [
        and_(
            Device.msp_id == msp_id,
            Device.status == DeviceStatus.ACTIVE,
        )
    ]

    scheduled_ids = []
    now = datetime.now(timezone.utc)

    for policy in policies:
        if policy.defer_until and policy.defer_until > now:
            logger.info("policy_deferred", extra={"policy_id": policy.id})
            continue

        q = select(Device).where(
            and_(
                Device.msp_id == msp_id,
                Device.status == DeviceStatus.ACTIVE,
                Device.current_version != release.version,
            )
        )
        if policy.target_customer_id:
            q = q.where(Device.customer_id == policy.target_customer_id)
        if policy.target_site_id:
            q = q.where(Device.site_id == policy.target_site_id)
        if policy.target_device_id:
            q = q.where(Device.id == policy.target_device_id)
        if policy.target_role:
            q = q.where(Device.role == policy.target_role)

        devices = (await db.execute(q)).scalars().all()

        # Apply rollout percentage deterministically by device ID hash
        for device in devices:
            bucket = int(device.id.replace("-", ""), 16) % 100
            if bucket >= policy.rollout_percent:
                continue

            # Skip if device version is already >= release version
            if device.current_version and not _version_lt(device.current_version, release.version):
                continue

            # Upsert update job
            existing = (await db.execute(
                select(DeviceUpdateJob).where(
                    and_(
                        DeviceUpdateJob.device_id == device.id,
                        DeviceUpdateJob.release_id == release.id,
                    )
                )
            )).scalar_one_or_none()

            if existing and existing.status in (
                UpdateStatus.COMPLETED, UpdateStatus.APPLYING, UpdateStatus.DOWNLOADING
            ):
                continue

            if not existing:
                job = DeviceUpdateJob(
                    device_id=device.id,
                    release_id=release.id,
                    msp_id=msp_id,
                    from_version=device.current_version,
                    to_version=release.version,
                    status=UpdateStatus.PENDING,
                )
                db.add(job)
                scheduled_ids.append(device.id)
            elif existing.status == UpdateStatus.FAILED:
                existing.status = UpdateStatus.PENDING
                existing.error = None
                scheduled_ids.append(device.id)

    await db.flush()
    return scheduled_ids


async def notify_device_of_update(
    device_id: str,
    release: ClientRelease,
    job_id: str,
    forced: bool = False,
) -> None:
    """Push an update-available message to the device over WebSocket."""
    message = {
        "type": "update_available",
        "job_id": job_id,
        "version": release.version,
        "sha256": release.artifact_sha256,
        "size_bytes": release.artifact_size_bytes,
        "forced": forced,
        "download_url": f"/v1/client/updates/{release.id}/artifact",
    }
    delivered = await cm.send_to_device(device_id, message)
    logger.info(
        "update_notification_sent",
        extra={"device_id": device_id, "version": release.version, "delivered": delivered},
    )


async def record_update_state(
    db: AsyncSession,
    job_id: str,
    device_id: str,
    new_status: UpdateStatus,
    error: Optional[str] = None,
    rollback_reason: Optional[str] = None,
) -> None:
    now = datetime.now(timezone.utc)
    job = (await db.execute(
        select(DeviceUpdateJob).where(
            and_(DeviceUpdateJob.id == job_id, DeviceUpdateJob.device_id == device_id)
        )
    )).scalar_one_or_none()
    if not job:
        return

    job.status = new_status
    if error:
        job.error = error
    if rollback_reason:
        job.rollback_reason = rollback_reason

    if new_status == UpdateStatus.DOWNLOADING:
        job.download_started_at = now
    elif new_status == UpdateStatus.APPLYING:
        job.apply_started_at = now
    elif new_status in (UpdateStatus.COMPLETED, UpdateStatus.FAILED, UpdateStatus.ROLLED_BACK):
        job.completed_at = now

    await db.flush()
