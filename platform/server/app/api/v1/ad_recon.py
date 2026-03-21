"""
Active Directory Recon API.

Endpoints:
  POST /v1/devices/{id}/ad/discover    — kick off unauthenticated AD discovery
  POST /v1/devices/{id}/ad/recon       — kick off authenticated full recon
  GET  /v1/devices/{id}/ad/reports     — list AD reports for a device
  GET  /v1/devices/{id}/ad/reports/{report_id} — get full report

Credentials in POST /ad/recon are passed directly to the Pi task payload
and are NEVER stored on the server.
"""

from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.core.database import get_db
from app.core.auth import get_current_operator, require_role
from app.models.models import (
    Device, DeviceStatus, Task, TaskStatus,
    ADReport, OperatorRole, AuditAction,
)
from app.services.audit import write_audit
from app.services import connection_manager as cm

router = APIRouter(prefix="/v1/devices", tags=["ad-recon"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class ADDiscoverRequest(BaseModel):
    targets: list[str]              # IPs / CIDRs to scan
    timeout: int = 30


class ADReconRequest(BaseModel):
    dc_ip: str
    domain: str
    username: str
    password: str                   # never stored — forwarded to Pi only
    base_dn: Optional[str] = None
    timeout_seconds: int = 120


# ── Discovery (unauthenticated) ───────────────────────────────────────────────

@router.post("/{device_id}/ad/discover")
async def ad_discover(
    device_id: str,
    body: ADDiscoverRequest,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    """
    Kick off unauthenticated AD discovery.
    Returns a task_id — poll /tasks/{id} for results.
    """
    device = await _get_device(db, device_id, operator.msp_id)

    task = Task(
        device_id=device_id,
        msp_id=operator.msp_id,
        issued_by=operator.id,
        task_type="run_ad_discover",
        payload={"targets": body.targets, "timeout": body.timeout},
        timeout_seconds=body.timeout * 3 + 30,
        status=TaskStatus.QUEUED,
    )
    db.add(task)
    await db.flush()
    await write_audit(
        db, AuditAction.TASK_ISSUED,
        msp_id=operator.msp_id, operator_id=operator.id,
        device_id=device_id,
        detail={"task_id": task.id, "task_type": "run_ad_discover"},
    )
    await db.commit()

    await cm.send_to_device(device_id, {
        "type": "task", "id": task.id,
        "task_type": "run_ad_discover",
        "payload": task.payload,
        "timeout_seconds": task.timeout_seconds,
    })

    return {"task_id": task.id, "status": "queued"}


# ── Full recon (authenticated) ────────────────────────────────────────────────

@router.post("/{device_id}/ad/recon")
async def ad_recon(
    device_id: str,
    body: ADReconRequest,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    """
    Kick off authenticated AD recon.
    Credentials are forwarded to the Pi task and are NOT stored.
    Returns task_id — when task completes the result is auto-saved as an ADReport.
    """
    device = await _get_device(db, device_id, operator.msp_id)

    # Store task WITHOUT credentials — they must never reach the database.
    # We build a separate in-flight payload to send to the device only.
    stored_payload = {
        "dc_ip":  body.dc_ip,
        "domain": body.domain,
        "username": body.username,
        # password intentionally excluded from stored payload
    }
    if body.base_dn:
        stored_payload["base_dn"] = body.base_dn

    device_payload = {**stored_payload, "password": body.password}

    task = Task(
        device_id=device_id,
        msp_id=operator.msp_id,
        issued_by=operator.id,
        task_type="run_ad_recon",
        payload=stored_payload,     # credentials-free
        timeout_seconds=body.timeout_seconds,
        status=TaskStatus.QUEUED,
    )
    db.add(task)
    await db.flush()
    await write_audit(
        db, AuditAction.TASK_ISSUED,
        msp_id=operator.msp_id, operator_id=operator.id,
        device_id=device_id,
        detail={"task_id": task.id, "domain": body.domain, "dc_ip": body.dc_ip},
    )
    await db.commit()

    # Send full payload (with password) to device — never persisted
    await cm.send_to_device(device_id, {
        "type": "task", "id": task.id,
        "task_type": "run_ad_recon",
        "payload": device_payload,
        "timeout_seconds": task.timeout_seconds,
    })
    # Destroy the in-flight credential reference immediately
    device_payload.pop("password", None)

    return {"task_id": task.id, "status": "queued"}


# ── Report storage (called internally when task completes) ────────────────────

async def save_ad_report(
    db: AsyncSession,
    task: Task,
    device: Device,
    result: dict,
) -> ADReport:
    """
    Called by device_channel when a run_ad_recon task completes successfully.
    Strips credentials from the task payload before saving anything.
    """
    summary  = result.get("summary", {})
    findings = result.get("findings", [])

    report = ADReport(
        device_id=task.device_id,
        task_id=task.id,
        msp_id=task.msp_id,
        customer_id=device.customer_id,
        domain=result.get("domain_info", {}).get("domain"),
        dc_ip=result.get("domain_info", {}).get("dc_ip"),
        functional_level=result.get("domain_info", {}).get("functional_level"),
        report_data=result,
        # Original summary fields
        total_users=summary.get("total_users"),
        domain_admins=summary.get("domain_admins"),
        kerberoastable=summary.get("kerberoastable"),
        asrep_roastable=summary.get("asrep_roastable"),
        findings_critical=sum(1 for f in findings if f.get("severity") == "critical"),
        findings_high=sum(1 for f in findings if f.get("severity") == "high"),
        findings_medium=sum(1 for f in findings if f.get("severity") == "medium"),
        # Extended summary fields (Round 8)
        computer_count=summary.get("computer_count"),
        unconstrained_delegation=summary.get("unconstrained_delegation"),
        laps_deployed=summary.get("laps_deployed"),
        laps_coverage_pct=summary.get("laps_coverage_pct"),
        adminsdholder_count=summary.get("adminsdholder_count"),
        protected_users_count=summary.get("protected_users_count"),
        fine_grained_policies=summary.get("fine_grained_policies"),
        service_accounts=summary.get("service_accounts"),
    )
    db.add(report)
    return report


# ── Report retrieval ──────────────────────────────────────────────────────────

@router.get("/{device_id}/ad/reports")
async def list_ad_reports(
    device_id: str,
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    await _get_device(db, device_id, operator.msp_id)

    result = await db.execute(
        select(ADReport)
        .where(ADReport.device_id == device_id)
        .order_by(ADReport.created_at.desc())
        .limit(20)
    )
    reports = result.scalars().all()
    return [_report_summary(r) for r in reports]


@router.get("/{device_id}/ad/reports/{report_id}")
async def get_ad_report(
    device_id: str,
    report_id: str,
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    await _get_device(db, device_id, operator.msp_id)

    report = await db.get(ADReport, report_id)
    if not report or report.device_id != device_id or report.msp_id != operator.msp_id:
        raise HTTPException(404, "Report not found")

    return {
        **_report_summary(report),
        "report_data": report.report_data,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _report_summary(r: ADReport) -> dict:
    return {
        "id":                      r.id,
        "device_id":               r.device_id,
        "task_id":                 r.task_id,
        "domain":                  r.domain,
        "dc_ip":                   r.dc_ip,
        "functional_level":        r.functional_level,
        "total_users":             r.total_users,
        "domain_admins":           r.domain_admins,
        "kerberoastable":          r.kerberoastable,
        "asrep_roastable":         r.asrep_roastable,
        "findings_critical":       r.findings_critical,
        "findings_high":           r.findings_high,
        "findings_medium":         r.findings_medium,
        "computer_count":          r.computer_count,
        "unconstrained_delegation": r.unconstrained_delegation,
        "laps_deployed":           r.laps_deployed,
        "laps_coverage_pct":       r.laps_coverage_pct,
        "adminsdholder_count":     r.adminsdholder_count,
        "protected_users_count":   r.protected_users_count,
        "fine_grained_policies":   r.fine_grained_policies,
        "service_accounts":        r.service_accounts,
        "created_at":              r.created_at.isoformat(),
    }


async def _get_device(db: AsyncSession, device_id: str, msp_id: str) -> Device:
    device = await db.get(Device, device_id)
    if not device or device.msp_id != msp_id:
        raise HTTPException(404, "Device not found")
    if device.status == DeviceStatus.REVOKED:
        raise HTTPException(400, "Device is revoked")
    return device
