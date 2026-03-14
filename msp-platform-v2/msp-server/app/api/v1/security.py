"""
Security scanning API.

Endpoints:
  POST /v1/devices/{id}/scan/vuln     — kick off vuln scan
  POST /v1/devices/{id}/scan/audit    — kick off security audit
  GET  /v1/findings                   — list findings (MSP-wide, filterable)
  GET  /v1/devices/{id}/findings      — findings for one device
  POST /v1/findings/{id}/acknowledge  — mark finding acknowledged
  DELETE /v1/findings/{id}            — delete a finding
"""

from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, update as sql_update

from app.core.database import get_db
from app.core.auth import get_current_operator, require_role
from app.models.models import (
    Device, DeviceStatus, Task, TaskStatus,
    ScanFinding, FindingSeverity, OperatorRole, AuditAction,
)
from app.services.audit import write_audit
from app.services import connection_manager as cm

router = APIRouter(tags=["security"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class VulnScanRequest(BaseModel):
    targets: list[str]
    intensity: str = "safe"       # safe | default | aggressive
    ports: Optional[str] = None
    top_ports: Optional[int] = None   # overrides intensity default if set
    timeout: Optional[int] = None     # omit to use per-intensity default


class SecurityAuditRequest(BaseModel):
    targets: list[str]
    checks: Optional[list[str]] = None   # None = all checks


class AcknowledgeRequest(BaseModel):
    notes: Optional[str] = None


# ── Scan dispatch ─────────────────────────────────────────────────────────────

@router.post("/v1/devices/{device_id}/scan/vuln")
async def run_vuln_scan(
    device_id: str,
    body: VulnScanRequest,
    operator=Depends(require_role(OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    device = await _get_device(db, device_id, operator.msp_id)

    # Per-intensity host timeouts mirror the agent's INTENSITY_SETTINGS
    INTENSITY_HOST_TIMEOUT = {"safe": 120, "default": 300, "aggressive": 600}
    host_timeout_s = INTENSITY_HOST_TIMEOUT.get(body.intensity, 120)
    task_timeout   = host_timeout_s * len(body.targets) + 60

    payload: dict = {"targets": body.targets, "intensity": body.intensity}
    if body.ports:
        payload["ports"] = body.ports
    if body.top_ports:
        payload["top_ports"] = body.top_ports
    if body.timeout is not None:
        payload["timeout"] = body.timeout

    task = Task(
        device_id=device_id, msp_id=operator.msp_id, issued_by=operator.id,
        task_type="run_vuln_scan", payload=payload,
        timeout_seconds=task_timeout,
        status=TaskStatus.QUEUED,
    )
    db.add(task)
    await db.flush()
    await write_audit(db, AuditAction.TASK_ISSUED, msp_id=operator.msp_id,
        operator_id=operator.id, device_id=device_id,
        detail={"task_id": task.id, "targets": body.targets, "intensity": body.intensity})
    await db.commit()
    await cm.send_to_device(device_id, {
        "type": "task", "id": task.id, "task_type": "run_vuln_scan",
        "payload": task.payload, "timeout_seconds": task.timeout_seconds,
    })
    return {"task_id": task.id, "status": "queued"}


@router.post("/v1/devices/{device_id}/scan/audit")
async def run_security_audit(
    device_id: str,
    body: SecurityAuditRequest,
    operator=Depends(require_role(OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    device = await _get_device(db, device_id, operator.msp_id)
    payload = {"targets": body.targets}
    if body.checks:
        payload["checks"] = body.checks

    task = Task(
        device_id=device_id, msp_id=operator.msp_id, issued_by=operator.id,
        task_type="run_security_audit", payload=payload,
        timeout_seconds=300, status=TaskStatus.QUEUED,
    )
    db.add(task)
    await db.flush()
    await write_audit(db, AuditAction.TASK_ISSUED, msp_id=operator.msp_id,
        operator_id=operator.id, device_id=device_id,
        detail={"task_id": task.id, "targets": body.targets})
    await db.commit()
    await cm.send_to_device(device_id, {
        "type": "task", "id": task.id, "task_type": "run_security_audit",
        "payload": task.payload, "timeout_seconds": task.timeout_seconds,
    })
    return {"task_id": task.id, "status": "queued"}


# ── Finding storage (called from device_channel on task completion) ────────────

async def save_scan_findings(
    db: AsyncSession,
    task: Task,
    device: Device,
    result: dict,
):
    """Parse findings from a completed vuln_scan or security_audit result and store them."""
    scan_type = "vuln_scan" if task.task_type == "run_vuln_scan" else "security_audit"
    findings_data = result.get("findings", [])

    for f in findings_data:
        sev_str = f.get("severity", "info").lower()
        try:
            severity = FindingSeverity(sev_str)
        except ValueError:
            severity = FindingSeverity.INFO

        # Guard: skip findings if device has no customer assigned (would violate FK)
        if not device.customer_id:
            continue

        finding = ScanFinding(
            device_id=task.device_id,
            task_id=task.id,
            msp_id=task.msp_id,
            customer_id=device.customer_id,
            scan_type=scan_type,
            # Both vuln_scan and security_audit use "ip"; also accept "host"/"target_ip"
            target_ip=f.get("ip") or f.get("host") or f.get("target_ip"),
            target_port=f.get("port") or f.get("target_port"),
            protocol=f.get("protocol"),
            severity=severity,
            title=f.get("title", "Unknown finding"),
            # security_audit uses "detail"; vuln_scan uses "output"; server normalises both
            description=f.get("description") or f.get("detail") or f.get("output"),
            script_id=f.get("script_id") or f.get("script") or f.get("check"),
            cve_id=f.get("cve_id"),
            cvss_score=f.get("cvss"),
            raw_output=f.get("raw_output") or f.get("output"),
        )
        db.add(finding)

    return len(findings_data)


# ── Finding retrieval ─────────────────────────────────────────────────────────

@router.get("/v1/findings")
async def list_findings(
    severity: Optional[str] = Query(default=None),
    scan_type: Optional[str] = Query(default=None),
    device_id: Optional[str] = Query(default=None),
    acknowledged: Optional[bool] = Query(default=None),
    limit: int = Query(default=200, le=500),
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    q = select(ScanFinding).where(ScanFinding.msp_id == operator.msp_id)
    if severity:
        try:
            q = q.where(ScanFinding.severity == FindingSeverity(severity))
        except ValueError:
            pass
    if scan_type:
        q = q.where(ScanFinding.scan_type == scan_type)
    if device_id:
        q = q.where(ScanFinding.device_id == device_id)
    if acknowledged is not None:
        q = q.where(ScanFinding.acknowledged == acknowledged)

    q = q.order_by(
        ScanFinding.found_at.desc()
    ).limit(limit)

    result = await db.execute(q)
    return [_finding_dict(f) for f in result.scalars().all()]


@router.get("/v1/devices/{device_id}/findings")
async def device_findings(
    device_id: str,
    severity: Optional[str] = Query(default=None),
    acknowledged: Optional[bool] = Query(default=False),
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    await _get_device(db, device_id, operator.msp_id)
    q = select(ScanFinding).where(ScanFinding.device_id == device_id)
    if severity:
        try:
            q = q.where(ScanFinding.severity == FindingSeverity(severity))
        except ValueError:
            pass
    if acknowledged is not None:
        q = q.where(ScanFinding.acknowledged == acknowledged)
    q = q.order_by(ScanFinding.found_at.desc())
    result = await db.execute(q)
    return [_finding_dict(f) for f in result.scalars().all()]


@router.post("/v1/findings/{finding_id}/acknowledge")
async def acknowledge_finding(
    finding_id: str,
    body: AcknowledgeRequest,
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    finding = await db.get(ScanFinding, finding_id)
    if not finding or finding.msp_id != operator.msp_id:
        raise HTTPException(404, "Finding not found")
    new_state = not finding.acknowledged
    finding.acknowledged    = new_state
    finding.acknowledged_by = operator.id if new_state else None
    finding.acknowledged_at = datetime.now(timezone.utc) if new_state else None
    if body.notes is not None:
        finding.notes = body.notes
    await db.commit()
    return _finding_dict(finding)


@router.delete("/v1/findings/{finding_id}", status_code=204)
async def delete_finding(
    finding_id: str,
    operator=Depends(require_role(OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    finding = await db.get(ScanFinding, finding_id)
    if not finding or finding.msp_id != operator.msp_id:
        raise HTTPException(404, "Finding not found")
    await db.delete(finding)
    await db.commit()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _finding_dict(f: ScanFinding) -> dict:
    return {
        "id":               f.id,
        "device_id":        f.device_id,
        "task_id":          f.task_id,
        "scan_type":        f.scan_type,
        "target_ip":        f.target_ip,
        "target_port":      f.target_port,
        "protocol":         f.protocol,
        "severity":         f.severity,
        "title":            f.title,
        "description":      f.description,
        "script_id":        f.script_id,
        "cve_id":           f.cve_id,
        "cvss_score":       f.cvss_score,
        "raw_output":       f.raw_output,
        "acknowledged":     f.acknowledged,
        "acknowledged_at":  f.acknowledged_at.isoformat() if f.acknowledged_at else None,
        "notes":            f.notes,
        "found_at":         f.found_at.isoformat(),
    }


async def _get_device(db: AsyncSession, device_id: str, msp_id: str) -> Device:
    device = await db.get(Device, device_id)
    if not device or device.msp_id != msp_id:
        raise HTTPException(404, "Device not found")
    if device.status == DeviceStatus.REVOKED:
        raise HTTPException(400, "Device is revoked")
    return device
