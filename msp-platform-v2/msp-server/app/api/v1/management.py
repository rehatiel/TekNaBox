"""
Operator management API: devices, tasks, updates, tenants.
All endpoints require operator JWT. Tenant isolation enforced at query level.
"""

import uuid
from datetime import datetime, timezone  # noqa: F401 (timezone used in network endpoints)
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, update as sql_update
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.auth import get_current_operator, require_role, get_current_device
from app.core.security import (
    generate_enrollment_secret, hash_enrollment_secret,
    hash_password, create_operator_token, verify_password,
    compute_sha256,
)
from app.models.models import (
    MSPOrganization, CustomerOrganization, Site, Device, DeviceStatus,
    DeviceRole, Task, TaskStatus, Operator, OperatorRole,
    ClientRelease, UpdatePolicy, DeviceUpdateJob, UpdateStatus, AuditAction,
    DiscoveredDevice,
)
from app.services.audit import write_audit

# ── Short-lived WebSocket ticket store (Redis-backed) ─────────────────────────
# Tickets are stored in Redis with a TTL so all uvicorn workers share the same
# store. In-memory dicts would break multi-worker deployments because a ticket
# issued by worker A would be invisible to worker B.
import json as _json
import secrets as _secrets

_WS_TICKET_TTL = 30  # seconds
_TICKET_PREFIX = "ws_ticket:"


def _get_redis():
    from app.services.connection_manager import _get_redis as _cm_get_redis
    return _cm_get_redis()


async def issue_ws_ticket(operator_id: str, msp_id: str) -> str:
    ticket = _secrets.token_urlsafe(32)
    payload = _json.dumps({"operator_id": operator_id, "msp_id": msp_id})
    r = _get_redis()
    await r.set(f"{_TICKET_PREFIX}{ticket}", payload, ex=_WS_TICKET_TTL)
    return ticket


async def consume_ws_ticket(ticket: str) -> dict | None:
    """Validate and consume a WS ticket atomically. Returns payload or None."""
    r = _get_redis()
    key = f"{_TICKET_PREFIX}{ticket}"
    # Pipeline: GET then DELETE — single-use guarantee
    pipe = r.pipeline()
    await pipe.get(key)
    await pipe.delete(key)
    results = await pipe.execute()
    raw = results[0]
    if not raw:
        return None
    return _json.loads(raw)
from app.services.update_service import evaluate_rollout, notify_device_of_update
from app.services import connection_manager as cm
import aiofiles
import os

router = APIRouter(prefix="/v1", tags=["management"])


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    operator_id: str
    role: str


@router.post("/auth/login", response_model=LoginResponse, tags=["auth"])
@limiter.limit("10/minute")  # brute-force protection
async def login(body: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Operator).where(Operator.email == body.email))
    op = result.scalar_one_or_none()
    # Always run bcrypt verify to prevent timing-based user enumeration.
    # Use a dummy hash when account not found so response time is consistent.
    _DUMMY_HASH = "$2b$12$KIX5/7iSlsGfB1gCqJr8EOeKCJWoLqmPJb4Yd.8pLjFqBLaFxhMVW"
    stored_hash = op.password_hash if op and op.is_active else _DUMMY_HASH
    password_ok = verify_password(body.password, stored_hash)
    if not op or not op.is_active or not password_ok:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    op.last_login_at = datetime.now(timezone.utc)
    await write_audit(
        db, AuditAction.OPERATOR_LOGIN,
        msp_id=op.msp_id, operator_id=op.id,
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()

    token = create_operator_token({"sub": op.id, "msp_id": op.msp_id, "role": op.role})
    return LoginResponse(access_token=token, operator_id=op.id, role=op.role)


# ── Devices ───────────────────────────────────────────────────────────────────

class CreateDeviceRequest(BaseModel):
    name: str
    site_id: str
    role: DeviceRole = DeviceRole.DIAGNOSTIC


class CreateDeviceResponse(BaseModel):
    device_id: str
    enrollment_secret: str  # shown once, never stored in plaintext


@router.post("/devices", response_model=CreateDeviceResponse)
async def create_device(
    body: CreateDeviceRequest,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    # Verify site belongs to operator's MSP
    site_result = await db.execute(
        select(Site).where(and_(Site.id == body.site_id, Site.msp_id == operator.msp_id))
    )
    site = site_result.scalar_one_or_none()
    if not site:
        raise HTTPException(status_code=404, detail="Site not found")

    secret = generate_enrollment_secret()
    device = Device(
        name=body.name,
        site_id=site.id,
        customer_id=site.customer_id,
        msp_id=operator.msp_id,
        role=body.role,
        status=DeviceStatus.PENDING,
        enrollment_secret_hash=hash_enrollment_secret(secret),
    )
    db.add(device)
    await db.flush()

    await write_audit(
        db, AuditAction.DEVICE_ENROLLED,
        msp_id=operator.msp_id, operator_id=operator.id,
        device_id=device.id, detail={"name": body.name, "site_id": body.site_id},
    )
    await db.commit()
    return CreateDeviceResponse(device_id=device.id, enrollment_secret=secret)


@router.get("/devices")
async def list_devices(
    customer_id: Optional[str] = None,
    site_id: Optional[str] = None,
    status: Optional[DeviceStatus] = None,
    limit: int = 200,
    offset: int = 0,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    q = select(Device).options(selectinload(Device.customer)).where(Device.msp_id == operator.msp_id)
    if customer_id:
        q = q.where(Device.customer_id == customer_id)
    if site_id:
        q = q.where(Device.site_id == site_id)
    if status:
        q = q.where(Device.status == status)
    q = q.order_by(Device.created_at.desc()).limit(min(limit, 500)).offset(offset)
    devices = (await db.execute(q)).scalars().all()
    return [_device_dict(d) for d in devices]


@router.post("/devices/{device_id}/revoke")
async def revoke_device(
    device_id: str,
    reason: Optional[str] = None,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    device = await _get_device(db, device_id, operator.msp_id)
    device.status = DeviceStatus.REVOKED
    device.revoked_at = datetime.now(timezone.utc)
    device.revoke_reason = reason

    # Send kill signal if connected
    await cm.send_to_device(device_id, {"type": "kill", "reason": reason or "revoked"})

    await write_audit(
        db, AuditAction.DEVICE_REVOKED,
        msp_id=operator.msp_id, operator_id=operator.id,
        device_id=device_id, detail={"reason": reason},
    )
    await db.commit()
    return {"status": "revoked"}


@router.post("/devices/{device_id}/reset")
async def reset_device(
    device_id: str,
    reason: Optional[str] = None,
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    """
    Reset a device back to PENDING so it can re-enroll.
    Clears hardware_id, token, and enrollment state.
    Useful when reimaging a Pi or moving it to a new site.
    Sends a kill signal if currently connected.
    """
    device = await _get_device(db, device_id, operator.msp_id)

    # Kick it off if connected
    await cm.send_to_device(device_id, {"type": "kill", "reason": "device reset by operator"})

    # Generate a fresh enrollment secret
    secret = generate_enrollment_secret()

    device.status = DeviceStatus.PENDING
    device.hardware_id = None
    device.fingerprint = None
    device.enrollment_secret_hash = hash_enrollment_secret(secret)
    device.enrolled_at = None
    device.last_seen_at = None
    device.last_ip = None
    device.current_version = None
    device.reported_arch = None
    device.revoked_at = None
    device.revoke_reason = None

    await write_audit(
        db, AuditAction.DEVICE_ENROLLED,  # reuse enrolled action
        msp_id=operator.msp_id, operator_id=operator.id,
        device_id=device_id, detail={"action": "reset", "reason": reason},
    )
    await db.commit()

    return {
        "status": "reset",
        "enrollment_secret": secret,  # shown once — operator must copy this
    }


@router.delete("/devices/{device_id}")
async def delete_device(
    device_id: str,
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    """
    Permanently delete a device record.
    Requires MSP_ADMIN role.
    Sends kill signal first if connected, then removes all child rows in
    FK-dependency order before deleting the device itself.
    """
    from sqlalchemy import delete as sql_delete
    from app.models.models import (
        Task, Telemetry, DeviceUpdateJob, ADReport, ScanFinding,
        MonitorTarget, UptimeCheck,
    )

    device = await _get_device(db, device_id, operator.msp_id)

    # Kick off connected agent before deleting
    await cm.send_to_device(device_id, {"type": "kill", "reason": "device deleted"})

    # Write audit in its own commit BEFORE the delete transaction.
    # The audit_logs table has a Postgres NO-DELETE rule; mixing an audit
    # INSERT with the cascade deletes in the same transaction causes a
    # constraint error on some PG configurations.
    try:
        await write_audit(
            db, AuditAction.DEVICE_REVOKED,
            msp_id=operator.msp_id, operator_id=operator.id,
            device_id=device_id, detail={"action": "deleted"},
        )
        await db.commit()
    except Exception:
        await db.rollback()

    # Delete child rows in FK-safe order (deepest children first).
    # audit_logs.device_id is a bare UUID with no FK — safe to leave as-is.
    for model in (
        UptimeCheck,       # → device_id
        MonitorTarget,     # → device_id
        ScanFinding,       # → device_id, task_id
        ADReport,          # → device_id, task_id
        Telemetry,         # → device_id
        DeviceUpdateJob,   # → device_id
        Task,              # → device_id
    ):
        await db.execute(sql_delete(model).where(model.device_id == device_id))

    await db.delete(device)
    await db.commit()

    return {"status": "deleted"}


# ── Tasks ─────────────────────────────────────────────────────────────────────

# Canonical list of task types the agent understands.
# Adding a new task module requires updating this list AND core/dispatcher.py.
ALLOWED_TASK_TYPES: frozenset[str] = frozenset({
    # System
    "get_sysinfo", "run_speedtest",
    # Network discovery
    "run_ping_sweep", "run_arp_scan", "run_nmap_scan", "run_port_scan",
    "run_netbios_scan", "run_lldp_neighbors", "run_wireless_survey", "run_wol",
    # Diagnostics
    "run_dns_lookup", "run_traceroute", "run_mtr", "run_iperf",
    "run_banner_grab", "run_packet_capture", "run_http_monitor", "run_ntp_check",
    # SNMP
    "run_snmp_query",
    # Security & compliance
    "run_ssl_check", "run_dns_health", "run_vuln_scan", "run_security_audit",
    "run_default_creds", "run_cleartext_services",
    # SMB
    "run_smb_enum",
    # Active Directory
    "run_ad_discover", "run_ad_recon",
    # Prospecting
    "run_email_breach",
})


class IssueTaskRequest(BaseModel):
    task_type: str
    payload: Optional[dict] = None
    timeout_seconds: int = 300
    idempotency_key: Optional[str] = None


@router.get("/task-types")
async def list_task_types(operator: Operator = Depends(get_current_operator)):
    """Return the list of known task types the agent can execute."""
    return {"task_types": sorted(ALLOWED_TASK_TYPES)}


@router.post("/devices/{device_id}/tasks")
async def issue_task(
    device_id: str,
    body: IssueTaskRequest,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    if body.task_type not in ALLOWED_TASK_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown task type: {body.task_type!r}. "
                   f"Call GET /v1/task-types for the list of valid types.",
        )

    device = await _get_device(db, device_id, operator.msp_id)
    if device.status == DeviceStatus.REVOKED:
        raise HTTPException(status_code=400, detail="Cannot task a revoked device")

    task = Task(
        device_id=device_id,
        msp_id=operator.msp_id,
        issued_by=operator.id,
        task_type=body.task_type,
        payload=body.payload,
        timeout_seconds=body.timeout_seconds,
        idempotency_key=body.idempotency_key,
        status=TaskStatus.QUEUED,
    )
    db.add(task)
    await db.flush()
    task_id = task.id  # capture before commit expires the ORM object

    # Commit task first — same pattern as enrollment: audit in its own txn
    # so the audit_logs NO-DELETE rule can't interfere with the task commit.
    await db.commit()

    try:
        await write_audit(
            db, AuditAction.TASK_ISSUED,
            msp_id=operator.msp_id, operator_id=operator.id,
            device_id=device_id,
            detail={"task_id": task_id, "task_type": body.task_type},
        )
        await db.commit()
    except Exception:
        await db.rollback()

    # Attempt immediate delivery if device is connected
    delivered = await cm.send_to_device(device_id, {
        "type": "task",
        "id": task_id,
        "task_type": body.task_type,
        "payload": body.payload or {},
        "timeout_seconds": body.timeout_seconds,
    })

    response = {"task_id": task_id, "status": TaskStatus.QUEUED}
    if device.status == DeviceStatus.OFFLINE or not delivered:
        response["warning"] = "Device appears offline — task queued and will be delivered when it reconnects."
    return response


@router.get("/devices/{device_id}/tasks")
async def get_device_tasks(
    device_id: str,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    await _get_device(db, device_id, operator.msp_id)  # access check
    tasks = (await db.execute(
        select(Task).where(Task.device_id == device_id).order_by(Task.queued_at.desc()).limit(100)
    )).scalars().all()
    return [_task_dict(t) for t in tasks]


# ── Releases & Updates ────────────────────────────────────────────────────────

ARTIFACT_BASE = os.getenv("ARTIFACT_BUCKET", "/artifacts")


class ReleaseResponse(BaseModel):
    id: str
    version: str
    arch: str
    channel: str
    sha256: str
    size_bytes: int
    is_mandatory: bool
    is_active: bool
    created_at: datetime


@router.post("/releases", response_model=ReleaseResponse)
async def upload_release(
    version: str,
    arch: str = "armv6l",
    channel: str = "stable",
    is_mandatory: bool = False,
    release_notes: Optional[str] = None,
    artifact: UploadFile = File(...),
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.SUPER_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    data = await artifact.read()
    sha256 = compute_sha256(data)

    # Persist artifact
    path = os.path.join(ARTIFACT_BASE, operator.msp_id or "platform", f"{version}-{arch}.bin")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    async with aiofiles.open(path, "wb") as f:
        await f.write(data)

    release = ClientRelease(
        msp_id=operator.msp_id,
        version=version,
        arch=arch,
        channel=channel,
        artifact_path=path,
        artifact_sha256=sha256,
        artifact_size_bytes=len(data),
        is_mandatory=is_mandatory,
        release_notes=release_notes,
        uploaded_by=operator.id,
    )
    db.add(release)
    await db.flush()

    await write_audit(
        db, AuditAction.UPDATE_DEPLOYED,
        msp_id=operator.msp_id, operator_id=operator.id,
        resource_type="release", resource_id=release.id,
        detail={"version": version, "arch": arch, "channel": channel},
    )
    await db.commit()
    return ReleaseResponse(
        id=release.id, version=release.version, arch=release.arch,
        channel=release.channel, sha256=sha256, size_bytes=len(data),
        is_mandatory=is_mandatory, is_active=True, created_at=release.created_at,
    )


@router.post("/releases/{release_id}/rollout")
async def trigger_rollout(
    release_id: str,
    customer_id: Optional[str] = None,
    site_id: Optional[str] = None,
    device_id: Optional[str] = None,
    rollout_percent: int = 100,
    is_forced: bool = False,
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.SUPER_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    release = await _get_release(db, release_id, operator.msp_id)

    policy = UpdatePolicy(
        msp_id=operator.msp_id,
        release_id=release_id,
        target_customer_id=customer_id,
        target_site_id=site_id,
        target_device_id=device_id,
        rollout_percent=rollout_percent,
        is_forced=is_forced,
        created_by=operator.id,
    )
    db.add(policy)
    await db.flush()

    scheduled = await evaluate_rollout(db, release, operator.msp_id, operator.id)
    await db.commit()

    # Notify connected devices
    for did in scheduled:
        job = (await db.execute(
            select(DeviceUpdateJob).where(
                and_(DeviceUpdateJob.device_id == did, DeviceUpdateJob.release_id == release_id)
            )
        )).scalar_one_or_none()
        if job:
            await notify_device_of_update(did, release, job.id, forced=is_forced)
            job.notified_at = datetime.now(timezone.utc)
            job.status = UpdateStatus.NOTIFIED
    await db.commit()

    return {"scheduled_devices": len(scheduled)}


@router.post("/releases/{release_id}/revoke")
async def revoke_release(
    release_id: str,
    reason: Optional[str] = None,
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.SUPER_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    release = await _get_release(db, release_id, operator.msp_id)
    release.is_active = False
    release.revoked_at = datetime.now(timezone.utc)
    release.revoke_reason = reason

    # Cancel all pending jobs for this release
    await db.execute(
        sql_update(DeviceUpdateJob)
        .where(
            and_(
                DeviceUpdateJob.release_id == release_id,
                DeviceUpdateJob.status.in_([UpdateStatus.PENDING, UpdateStatus.NOTIFIED]),
            )
        )
        .values(status=UpdateStatus.DEFERRED)
    )
    await write_audit(
        db, AuditAction.UPDATE_REVOKED,
        msp_id=operator.msp_id, operator_id=operator.id,
        resource_type="release", resource_id=release_id,
        detail={"reason": reason},
    )
    await db.commit()
    return {"status": "revoked"}


@router.get("/releases")
async def list_releases(
    channel: Optional[str] = None,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    q = select(ClientRelease).where(
        and_(ClientRelease.msp_id == operator.msp_id, ClientRelease.is_active)
    )
    if channel:
        q = q.where(ClientRelease.channel == channel)
    releases = (await db.execute(q.order_by(ClientRelease.created_at.desc()))).scalars().all()
    return [
        {
            "id": r.id, "version": r.version, "arch": r.arch, "channel": r.channel,
            "sha256": r.artifact_sha256, "size_bytes": r.artifact_size_bytes,
            "is_mandatory": r.is_mandatory, "created_at": r.created_at,
        }
        for r in releases
    ]


# ── Client update artifact download (device-authenticated) ────────────────────

@router.get("/client/updates/{release_id}/artifact")
async def download_artifact(
    release_id: str,
    device: Device = Depends(get_current_device),
    db: AsyncSession = Depends(get_db),
):
    from fastapi.responses import FileResponse
    release = await _get_release(db, release_id, device.msp_id)
    if not os.path.exists(release.artifact_path):
        raise HTTPException(status_code=404, detail="Artifact not found on server")
    return FileResponse(
        release.artifact_path,
        media_type="application/octet-stream",
        headers={"X-Artifact-SHA256": release.artifact_sha256},
    )


# ── Audit logs ────────────────────────────────────────────────────────────────


# Tasks (global list)

@router.get("/tasks")
async def list_all_tasks(
    device_id: Optional[str] = None,
    status: Optional[TaskStatus] = None,
    task_type: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """List tasks across all devices for this MSP."""
    q = select(Task).where(Task.msp_id == operator.msp_id)
    if device_id:
        q = q.where(Task.device_id == device_id)
    if status:
        q = q.where(Task.status == status)
    if task_type:
        q = q.where(Task.task_type == task_type)
    q = q.order_by(Task.queued_at.desc()).limit(limit).offset(offset)
    tasks = (await db.execute(q)).scalars().all()
    return [_task_dict(t) for t in tasks]

@router.get("/audit")
async def get_audit_logs(
    device_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    from app.models.models import AuditLog
    q = select(AuditLog).where(AuditLog.msp_id == operator.msp_id)
    if device_id:
        q = q.where(AuditLog.device_id == device_id)
    q = q.order_by(AuditLog.created_at.desc()).limit(limit).offset(offset)
    logs = (await db.execute(q)).scalars().all()
    return [
        {
            "id": l.id, "action": l.action, "operator_id": l.operator_id,
            "device_id": l.device_id, "resource_type": l.resource_type,
            "resource_id": l.resource_id, "detail": l.detail,
            "ip_address": l.ip_address, "created_at": l.created_at,
        }
        for l in logs
    ]


# ── Network Device History ────────────────────────────────────────────────────

class UpsertDeviceEntry(BaseModel):
    mac: str
    ip: Optional[str] = None
    vendor: Optional[str] = None
    hostname: Optional[str] = None

class UpsertDiscoveredDevicesRequest(BaseModel):
    device_id: str          # the agent that ran the scan
    devices: list[UpsertDeviceEntry]


@router.post("/network/discovered-devices")
async def upsert_discovered_devices(
    body: UpsertDiscoveredDevicesRequest,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Upsert batch of discovered devices from an ARP/network scan result."""
    now = datetime.now(timezone.utc)
    for entry in body.devices:
        mac = entry.mac.lower().strip()
        if not mac:
            continue
        existing = (await db.execute(
            select(DiscoveredDevice).where(
                and_(DiscoveredDevice.msp_id == operator.msp_id,
                     DiscoveredDevice.mac == mac)
            )
        )).scalar_one_or_none()

        if existing:
            if entry.ip:
                existing.ip = entry.ip
            if entry.vendor:
                existing.vendor = entry.vendor
            if entry.hostname:
                existing.hostname = entry.hostname
            existing.source_device_id = body.device_id
            existing.last_seen = now
        else:
            db.add(DiscoveredDevice(
                msp_id=operator.msp_id,
                source_device_id=body.device_id,
                mac=mac,
                ip=entry.ip,
                vendor=entry.vendor,
                hostname=entry.hostname,
                known=False,
                first_seen=now,
                last_seen=now,
            ))

    await db.commit()
    return {"ok": True}


@router.get("/network/discovered-devices")
async def list_discovered_devices(
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """List all discovered devices for this MSP."""
    rows = (await db.execute(
        select(DiscoveredDevice)
        .where(DiscoveredDevice.msp_id == operator.msp_id)
        .order_by(DiscoveredDevice.last_seen.desc())
    )).scalars().all()
    return [_discovered_device_dict(d) for d in rows]


@router.patch("/network/discovered-devices/{mac}/known")
async def set_device_known(
    mac: str,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Toggle a discovered device's known status."""
    mac = mac.lower().strip()
    device = (await db.execute(
        select(DiscoveredDevice).where(
            and_(DiscoveredDevice.msp_id == operator.msp_id,
                 DiscoveredDevice.mac == mac)
        )
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    device.known = not device.known
    await db.commit()
    return _discovered_device_dict(device)


@router.patch("/network/discovered-devices/{mac}/label")
async def set_device_label(
    mac: str,
    body: dict,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Set an operator label on a discovered device."""
    mac = mac.lower().strip()
    device = (await db.execute(
        select(DiscoveredDevice).where(
            and_(DiscoveredDevice.msp_id == operator.msp_id,
                 DiscoveredDevice.mac == mac)
        )
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    device.label = body.get("label") or None
    await db.commit()
    return _discovered_device_dict(device)


@router.delete("/network/discovered-devices/{mac}")
async def delete_discovered_device(
    mac: str,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Remove a device from the history."""
    mac = mac.lower().strip()
    device = (await db.execute(
        select(DiscoveredDevice).where(
            and_(DiscoveredDevice.msp_id == operator.msp_id,
                 DiscoveredDevice.mac == mac)
        )
    )).scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    await db.delete(device)
    await db.commit()
    return {"ok": True}


def _discovered_device_dict(d: DiscoveredDevice) -> dict:
    return {
        "id": d.id, "mac": d.mac, "ip": d.ip, "vendor": d.vendor,
        "hostname": d.hostname, "label": d.label, "known": d.known,
        "source_device_id": d.source_device_id,
        "first_seen": d.first_seen, "last_seen": d.last_seen,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_device(db: AsyncSession, device_id: str, msp_id: str) -> Device:
    result = await db.execute(
        select(Device).where(and_(Device.id == device_id, Device.msp_id == msp_id))
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


async def _get_release(db: AsyncSession, release_id: str, msp_id: str) -> ClientRelease:
    result = await db.execute(
        select(ClientRelease).where(
            and_(ClientRelease.id == release_id, ClientRelease.msp_id == msp_id)
        )
    )
    release = result.scalar_one_or_none()
    if not release:
        raise HTTPException(status_code=404, detail="Release not found")
    return release


def _device_dict(d: Device) -> dict:
    return {
        "id": d.id, "name": d.name, "status": d.status, "role": d.role,
        "site_id": d.site_id, "customer_id": d.customer_id, "msp_id": d.msp_id,
        "customer_name": d.customer.name if d.customer else None,
        "current_version": d.current_version, "last_seen_at": d.last_seen_at,
        "last_ip": d.last_ip, "hardware_id": d.hardware_id,
        "enrolled_at": d.enrolled_at, "revoke_reason": d.revoke_reason,
        "created_at": d.created_at,
    }


def _task_dict(t: Task) -> dict:
    return {
        "id": t.id, "device_id": t.device_id, "task_type": t.task_type, "status": t.status,
        "payload": t.payload, "result": t.result, "error": t.error,
        "queued_at": t.queued_at, "dispatched_at": t.dispatched_at, "completed_at": t.completed_at,
        "timeout_seconds": t.timeout_seconds,
    }

# ── WebSocket ticket issuance ─────────────────────────────────────────────────

@router.post("/ws-ticket", tags=["auth"])
async def get_ws_ticket(
    operator: Operator = Depends(get_current_operator),
):
    """
    Issue a short-lived (30s), single-use ticket for WebSocket authentication.
    The browser exchanges this ticket in the WS URL instead of the long-lived
    operator JWT, preventing credential exposure in server/nginx access logs.
    """
    ticket = await issue_ws_ticket(operator.id, operator.msp_id)
    return {"ticket": ticket, "expires_in": 30}
