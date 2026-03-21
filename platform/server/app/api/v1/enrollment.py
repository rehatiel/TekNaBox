"""
Device enrollment and token refresh endpoints.
Called by Raspberry Pi clients.
"""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.core.database import get_db
from app.core.security import (
    hash_enrollment_secret, create_device_token, compute_sha256
)
from app.core.auth import get_current_device
from app.models.models import Device, DeviceStatus, AuditAction
from app.services.audit import write_audit

router = APIRouter(prefix="/v1/enroll", tags=["enrollment"])


class EnrollRequest(BaseModel):
    enrollment_secret: str
    hardware_id: str
    arch: str
    current_version: str
    cert_fingerprint: str | None = None


class EnrollResponse(BaseModel):
    device_id: str
    access_token: str
    token_type: str = "bearer"


@router.post("", response_model=EnrollResponse)
async def enroll_device(
    body: EnrollRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    One-time enrollment. Device presents the enrollment_secret provisioned
    by an operator. On success, returns a JWT for all future communication.
    """
    from hashlib import sha256
    secret_hash = sha256(body.enrollment_secret.encode()).hexdigest()

    result = await db.execute(
        select(Device).where(
            and_(
                Device.enrollment_secret_hash == secret_hash,
                Device.status == DeviceStatus.PENDING,
            )
        )
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=401, detail="Invalid or already used enrollment secret")

    # Consume the enrollment secret
    device.enrollment_secret_hash = None
    device.hardware_id = body.hardware_id
    device.reported_arch = body.arch
    device.current_version = body.current_version
    device.fingerprint = body.cert_fingerprint
    device.status = DeviceStatus.ACTIVE
    device.enrolled_at = datetime.now(timezone.utc)
    device.last_ip = request.client.host if request.client else None

    # Stash these before commit (device attributes may expire)
    device_id  = device.id
    device_msp = device.msp_id
    client_ip  = request.client.host if request.client else None

    # Commit device state change first — keeps this transaction simple and
    # avoids the audit_logs NO-DELETE rule firing inside the same txn.
    await db.commit()

    # Audit in a fresh transaction so any audit write failure is non-fatal
    # and doesn't roll back the enrollment itself.
    try:
        await write_audit(
            db,
            AuditAction.DEVICE_ENROLLED,
            msp_id=device_msp,
            device_id=device_id,
            detail={"hardware_id": body.hardware_id, "arch": body.arch, "version": body.current_version},
            ip_address=client_ip,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        # Audit failure must never block enrollment
        import logging
        logging.getLogger(__name__).warning(
            "Audit write failed after enrollment of device %s — continuing", device_id
        )

    token = create_device_token(device_id, device_msp)
    return EnrollResponse(device_id=device_id, access_token=token)


class TokenRefreshResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/refresh", response_model=TokenRefreshResponse)
async def refresh_device_token(
    device: Device = Depends(get_current_device),
    db: AsyncSession = Depends(get_db),
):
    """Devices call this periodically to rotate their JWT."""
    token = create_device_token(device.id, device.msp_id)
    return TokenRefreshResponse(access_token=token)
