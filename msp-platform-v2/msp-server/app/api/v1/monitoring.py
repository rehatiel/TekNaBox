"""
Uptime monitoring API.

Endpoints:
  GET  /v1/monitoring/targets              — list all monitor targets (scoped to MSP)
  POST /v1/monitoring/targets              — create a monitor target
  PUT  /v1/monitoring/targets/{id}         — update a target
  DELETE /v1/monitoring/targets/{id}       — delete a target

  GET  /v1/monitoring/uptime               — uptime summary for all devices
  GET  /v1/monitoring/devices/{id}/uptime  — uptime history for one device
  GET  /v1/monitoring/devices/{id}/rtt     — RTT time-series for one device/target
"""

from datetime import datetime, timezone, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func, delete, Integer

from app.core.database import get_db
from app.core.auth import get_current_operator, require_role
from app.models.models import (
    MonitorTarget, UptimeCheck, Device, DeviceStatus,
    OperatorRole,
)

router = APIRouter(prefix="/v1/monitoring", tags=["monitoring"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class MonitorTargetCreate(BaseModel):
    device_id: str
    label: str
    host: str
    enabled: bool = True
    interval_seconds: int = 30


class MonitorTargetUpdate(BaseModel):
    label: Optional[str] = None
    host: Optional[str] = None
    enabled: Optional[bool] = None
    interval_seconds: Optional[int] = None


# ── Monitor Targets ───────────────────────────────────────────────────────────

@router.get("/targets")
async def list_targets(
    device_id: Optional[str] = Query(default=None),
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    q = select(MonitorTarget).where(MonitorTarget.msp_id == operator.msp_id)
    if device_id:
        q = q.where(MonitorTarget.device_id == device_id)
    result = await db.execute(q.order_by(MonitorTarget.created_at))
    targets = result.scalars().all()
    return [_target_dict(t) for t in targets]


@router.post("/targets", status_code=201)
async def create_target(
    body: MonitorTargetCreate,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    # Verify device belongs to this MSP
    dev = await db.get(Device, body.device_id)
    if not dev or dev.msp_id != operator.msp_id:
        raise HTTPException(404, "Device not found")

    target = MonitorTarget(
        device_id=body.device_id,
        msp_id=operator.msp_id,
        customer_id=dev.customer_id,
        label=body.label,
        host=body.host,
        enabled=body.enabled,
        interval_seconds=body.interval_seconds,
    )
    db.add(target)
    await db.commit()
    await db.refresh(target)

    # Push updated target list to Pi via config_update
    await _push_targets_to_device(body.device_id, db)

    return _target_dict(target)


@router.put("/targets/{target_id}")
async def update_target(
    target_id: str,
    body: MonitorTargetUpdate,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(MonitorTarget, target_id)
    if not target or target.msp_id != operator.msp_id:
        raise HTTPException(404, "Target not found")

    for field, val in body.model_dump(exclude_none=True).items():
        setattr(target, field, val)
    await db.commit()

    await _push_targets_to_device(target.device_id, db)
    return _target_dict(target)


@router.delete("/targets/{target_id}", status_code=204)
async def delete_target(
    target_id: str,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    target = await db.get(MonitorTarget, target_id)
    if not target or target.msp_id != operator.msp_id:
        raise HTTPException(404, "Target not found")

    device_id = target.device_id
    await db.delete(target)
    await db.commit()

    await _push_targets_to_device(device_id, db)


# ── Uptime Summary ────────────────────────────────────────────────────────────

@router.get("/uptime")
async def uptime_summary(
    hours: int = Query(default=24, ge=1, le=168),
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Returns uptime % and latest RTT for each device over the last N hours."""
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    # Get all active devices for this MSP
    dev_result = await db.execute(
        select(Device).where(
            and_(
                Device.msp_id == operator.msp_id,
                Device.status.in_([DeviceStatus.ACTIVE, DeviceStatus.OFFLINE]),
            )
        )
    )
    devices = dev_result.scalars().all()
    device_ids = [d.id for d in devices]

    if not device_ids:
        return []

    # Aggregate uptime checks per device × source
    agg = await db.execute(
        select(
            UptimeCheck.device_id,
            UptimeCheck.source,
            func.count().label("total"),
            func.sum(UptimeCheck.success.cast(Integer)).label("successes"),
            func.avg(UptimeCheck.rtt_ms).label("avg_rtt"),
            func.min(UptimeCheck.rtt_ms).label("min_rtt"),
            func.max(UptimeCheck.rtt_ms).label("max_rtt"),
            func.max(UptimeCheck.checked_at).label("last_check"),
        )
        .where(
            and_(
                UptimeCheck.device_id.in_(device_ids),
                UptimeCheck.msp_id == operator.msp_id,
                UptimeCheck.checked_at >= since,
            )
        )
        .group_by(UptimeCheck.device_id, UptimeCheck.source)
    )
    rows = agg.all()

    # Per-target LAN breakdown
    target_agg = await db.execute(
        select(
            UptimeCheck.device_id,
            UptimeCheck.target,
            func.count().label("total"),
            func.sum(UptimeCheck.success.cast(Integer)).label("successes"),
            func.avg(UptimeCheck.rtt_ms).label("avg_rtt"),
            func.max(UptimeCheck.checked_at).label("last_check"),
        )
        .where(
            and_(
                UptimeCheck.device_id.in_(device_ids),
                UptimeCheck.msp_id == operator.msp_id,
                UptimeCheck.checked_at >= since,
                UptimeCheck.source == "lan",
                UptimeCheck.target != "",
            )
        )
        .group_by(UptimeCheck.device_id, UptimeCheck.target)
    )
    target_rows = target_agg.all()

    # Load MonitorTarget labels so we can annotate per-target stats
    mt_result = await db.execute(
        select(MonitorTarget).where(MonitorTarget.msp_id == operator.msp_id)
    )
    label_by_host: dict[str, str] = {t.host: t.label for t in mt_result.scalars().all()}

    # Build per-device summary
    by_device: dict = {d.id: {"device_id": d.id, "device_name": d.name,
                               "status": d.status, "wan": None, "lan": None,
                               "lan_targets": []} for d in devices}

    for row in rows:
        total = row.total or 1
        pct = round((row.successes or 0) / total * 100, 1)
        entry = {
            "uptime_pct":   pct,
            "avg_rtt_ms":   round(row.avg_rtt, 2) if row.avg_rtt else None,
            "min_rtt_ms":   round(row.min_rtt, 2) if row.min_rtt else None,
            "max_rtt_ms":   round(row.max_rtt, 2) if row.max_rtt else None,
            "checks":       row.total,
            "last_check":   row.last_check.isoformat() if row.last_check else None,
        }
        if row.device_id in by_device:
            by_device[row.device_id][row.source] = entry

    for row in target_rows:
        if row.device_id not in by_device:
            continue
        total = row.total or 1
        pct = round((row.successes or 0) / total * 100, 1)
        by_device[row.device_id]["lan_targets"].append({
            "host":       row.target,
            "label":      label_by_host.get(row.target, row.target),
            "uptime_pct": pct,
            "avg_rtt_ms": round(row.avg_rtt, 2) if row.avg_rtt else None,
            "checks":     row.total,
            "last_check": row.last_check.isoformat() if row.last_check else None,
        })

    return list(by_device.values())


@router.get("/devices/{device_id}/uptime")
async def device_uptime(
    device_id: str,
    hours: int = Query(default=24, ge=1, le=168),
    source: Optional[str] = Query(default=None),  # "wan" | "lan" | None = both
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Uptime checks over time for one device — for sparkline/graph."""
    dev = await db.get(Device, device_id)
    if not dev or dev.msp_id != operator.msp_id:
        raise HTTPException(404, "Device not found")

    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    q = select(UptimeCheck).where(
        and_(
            UptimeCheck.device_id == device_id,
            UptimeCheck.checked_at >= since,
        )
    )
    if source:
        q = q.where(UptimeCheck.source == source)
    q = q.order_by(UptimeCheck.checked_at)

    result = await db.execute(q)
    checks = result.scalars().all()

    return {
        "device_id": device_id,
        "hours":     hours,
        "checks": [
            {
                "t":       c.checked_at.isoformat(),
                "success": c.success,
                "rtt_ms":  c.rtt_ms,
                "source":  c.source,
                "target":  c.target,
            }
            for c in checks
        ],
    }


@router.get("/devices/{device_id}/targets")
async def device_targets(
    device_id: str,
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """List monitor targets for a specific device."""
    dev = await db.get(Device, device_id)
    if not dev or dev.msp_id != operator.msp_id:
        raise HTTPException(404, "Device not found")

    result = await db.execute(
        select(MonitorTarget).where(MonitorTarget.device_id == device_id)
        .order_by(MonitorTarget.created_at)
    )
    return [_target_dict(t) for t in result.scalars().all()]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _target_dict(t: MonitorTarget) -> dict:
    return {
        "id":               t.id,
        "device_id":        t.device_id,
        "label":            t.label,
        "host":             t.host,
        "enabled":          t.enabled,
        "interval_seconds": t.interval_seconds,
        "created_at":       t.created_at.isoformat(),
    }


async def _push_targets_to_device(device_id: str, db: AsyncSession):
    """Send updated monitor target list to the agent via monitor_config message."""
    from app.services.connection_manager import send_to_device
    result = await db.execute(
        select(MonitorTarget).where(
            and_(MonitorTarget.device_id == device_id, MonitorTarget.enabled == True)
        )
    )
    targets = result.scalars().all()
    # Use the dedicated monitor_config message type that core/dispatcher.py handles
    await send_to_device(device_id, {
        "type":     "monitor_config",
        "targets":  [
            {"host": t.host, "label": t.label, "id": t.id}
            for t in targets
        ],
        "interval": min((t.interval_seconds for t in targets), default=30),
    })
