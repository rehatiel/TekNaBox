"""
Uptime monitor API.

Endpoints:
  GET    /v1/monitors                   — list all monitors with current status + tick data
  POST   /v1/monitors                   — create a monitor
  PUT    /v1/monitors/{id}              — update a monitor
  DELETE /v1/monitors/{id}              — delete a monitor (cascades checks)
  PATCH  /v1/monitors/{id}/toggle       — enable / disable
  GET    /v1/monitors/{id}/checks       — check history for charts (?hours=24)
"""

from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, and_, func, delete as sql_delete, Integer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.auth import get_current_operator, require_role
from app.models.models import (
    Monitor, MonitorCheck, MonitorType, Device,
    OperatorRole,
)

router = APIRouter(prefix="/v1/monitors", tags=["monitors"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class MonitorCreate(BaseModel):
    device_id:        str
    name:             str
    type:             MonitorType
    target:           str
    port:             Optional[int]  = None
    interval_seconds: int            = 60
    timeout_seconds:  int            = 10
    enabled:          bool           = True
    # HTTP
    http_method:          Optional[str] = "GET"
    http_expected_status: Optional[int] = 200
    http_keyword:         Optional[str] = None
    http_ignore_ssl:      bool          = False
    # DNS
    dns_record_type:    Optional[str] = "A"
    dns_expected_value: Optional[str] = None
    # Alerts
    alert_enabled:   bool = False
    alert_threshold: int  = 2


class MonitorUpdate(BaseModel):
    name:             Optional[str]  = None
    target:           Optional[str]  = None
    port:             Optional[int]  = None
    interval_seconds: Optional[int]  = None
    timeout_seconds:  Optional[int]  = None
    enabled:          Optional[bool] = None
    http_method:          Optional[str]  = None
    http_expected_status: Optional[int]  = None
    http_keyword:         Optional[str]  = None
    http_ignore_ssl:      Optional[bool] = None
    dns_record_type:    Optional[str] = None
    dns_expected_value: Optional[str] = None
    alert_enabled:   Optional[bool] = None
    alert_threshold: Optional[int]  = None


# ── List + detail ──────────────────────────────────────────────────────────────

@router.get("")
async def list_monitors(
    device_id: Optional[str] = Query(default=None),
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Return all monitors with current status and last 60 ticks."""
    q = select(Monitor).where(Monitor.msp_id == operator.msp_id)
    if device_id:
        q = q.where(Monitor.device_id == device_id)
    q = q.order_by(Monitor.created_at)
    monitors = (await db.execute(q)).scalars().all()

    # Fetch device names in one query
    dev_ids = list({m.device_id for m in monitors})
    devs = {}
    if dev_ids:
        rows = (await db.execute(
            select(Device.id, Device.name).where(Device.id.in_(dev_ids))
        )).all()
        devs = {r.id: r.name for r in rows}

    # Fetch last 60 checks per monitor (for tick bar) in one query
    since = datetime.now(timezone.utc) - timedelta(hours=72)  # plenty of room
    tick_rows = (await db.execute(
        select(MonitorCheck)
        .where(
            and_(
                MonitorCheck.monitor_id.in_([m.id for m in monitors]),
                MonitorCheck.checked_at >= since,
            )
        )
        .order_by(MonitorCheck.monitor_id, MonitorCheck.checked_at.desc())
    )).scalars().all()

    # Group ticks per monitor (last 60, chronological order)
    from collections import defaultdict
    ticks_by_monitor: dict[str, list] = defaultdict(list)
    counts: dict[str, int] = defaultdict(int)
    for row in tick_rows:
        if counts[row.monitor_id] < 60:
            ticks_by_monitor[row.monitor_id].insert(0, {
                "t":       row.checked_at.isoformat(),
                "success": row.success,
                "rtt_ms":  row.rtt_ms,
                "error":   row.error,
            })
            counts[row.monitor_id] += 1

    # Compute 24h uptime per monitor
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    uptime_rows = (await db.execute(
        select(
            MonitorCheck.monitor_id,
            func.count().label("total"),
            func.sum(MonitorCheck.success.cast(Integer)).label("up"),
            func.avg(MonitorCheck.rtt_ms).label("avg_rtt"),
        )
        .where(
            and_(
                MonitorCheck.monitor_id.in_([m.id for m in monitors]),
                MonitorCheck.checked_at >= since_24h,
            )
        )
        .group_by(MonitorCheck.monitor_id)
    )).all()
    uptime_by_monitor = {
        r.monitor_id: {
            "uptime_pct": round((r.up or 0) / max(r.total, 1) * 100, 2),
            "avg_rtt_ms": round(r.avg_rtt, 1) if r.avg_rtt else None,
            "checks_24h": r.total,
        }
        for r in uptime_rows
    }

    return [
        _monitor_dict(m, devs.get(m.device_id, m.device_id[:8]),
                      ticks_by_monitor.get(m.id, []),
                      uptime_by_monitor.get(m.id, {}))
        for m in monitors
    ]


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_monitor(
    body: MonitorCreate,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    dev = await db.get(Device, body.device_id)
    if not dev or dev.msp_id != operator.msp_id:
        raise HTTPException(404, "Device not found")

    m = Monitor(
        msp_id=operator.msp_id,
        customer_id=dev.customer_id,
        **body.model_dump(),
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)

    await _push_config(m.device_id, db)
    return _monitor_dict(m, dev.name, [], {})


@router.put("/{monitor_id}")
async def update_monitor(
    monitor_id: str,
    body: MonitorUpdate,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    m = await _get_monitor(db, monitor_id, operator.msp_id)
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(m, field, val)
    await db.commit()
    await _push_config(m.device_id, db)
    dev = await db.get(Device, m.device_id)
    return _monitor_dict(m, dev.name if dev else m.device_id[:8], [], {})


@router.delete("/{monitor_id}", status_code=204)
async def delete_monitor(
    monitor_id: str,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    m = await _get_monitor(db, monitor_id, operator.msp_id)
    device_id = m.device_id
    await db.delete(m)
    await db.commit()
    await _push_config(device_id, db)


@router.patch("/{monitor_id}/toggle")
async def toggle_monitor(
    monitor_id: str,
    operator=Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    m = await _get_monitor(db, monitor_id, operator.msp_id)
    m.enabled = not m.enabled
    await db.commit()
    await _push_config(m.device_id, db)
    return {"enabled": m.enabled}


# ── Check history (for charts) ─────────────────────────────────────────────────

@router.get("/{monitor_id}/checks")
async def monitor_checks(
    monitor_id: str,
    hours: int = Query(default=24, ge=1, le=720),
    operator=Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    m = await _get_monitor(db, monitor_id, operator.msp_id)
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    rows = (await db.execute(
        select(MonitorCheck)
        .where(
            and_(
                MonitorCheck.monitor_id == monitor_id,
                MonitorCheck.checked_at >= since,
            )
        )
        .order_by(MonitorCheck.checked_at)
    )).scalars().all()

    checks = [
        {
            "t":               c.checked_at.isoformat(),
            "success":         c.success,
            "rtt_ms":          c.rtt_ms,
            "error":           c.error,
            "status_code":     c.status_code,
            "cert_expiry_days": c.cert_expiry_days,
            "keyword_match":   c.keyword_match,
            "dns_result":      c.dns_result,
        }
        for c in rows
    ]

    # Compute stats
    rtts = [c["rtt_ms"] for c in checks if c["rtt_ms"] is not None]
    up   = sum(1 for c in checks if c["success"])
    total = len(checks)

    # Jitter = mean absolute deviation of consecutive RTTs
    jitter = None
    if len(rtts) >= 2:
        diffs = [abs(rtts[i] - rtts[i-1]) for i in range(1, len(rtts))]
        jitter = round(sum(diffs) / len(diffs), 1)

    return {
        "monitor_id":   monitor_id,
        "hours":        hours,
        "checks":       checks,
        "total":        total,
        "uptime_pct":   round(up / max(total, 1) * 100, 2),
        "avg_rtt_ms":   round(sum(rtts) / len(rtts), 1) if rtts else None,
        "min_rtt_ms":   round(min(rtts), 1) if rtts else None,
        "max_rtt_ms":   round(max(rtts), 1) if rtts else None,
        "jitter_ms":    jitter,
        "packet_loss_pct": round((total - up) / max(total, 1) * 100, 1),
    }


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _get_monitor(db: AsyncSession, monitor_id: str, msp_id: str) -> Monitor:
    m = await db.get(Monitor, monitor_id)
    if not m or m.msp_id != msp_id:
        raise HTTPException(404, "Monitor not found")
    return m


def _monitor_dict(m: Monitor, device_name: str, ticks: list, uptime: dict) -> dict:
    return {
        "id":               m.id,
        "name":             m.name,
        "type":             m.type,
        "target":           m.target,
        "port":             m.port,
        "interval_seconds": m.interval_seconds,
        "timeout_seconds":  m.timeout_seconds,
        "enabled":          m.enabled,
        "device_id":        m.device_id,
        "device_name":      device_name,
        # HTTP
        "http_method":          m.http_method,
        "http_expected_status": m.http_expected_status,
        "http_keyword":         m.http_keyword,
        "http_ignore_ssl":      m.http_ignore_ssl,
        # DNS
        "dns_record_type":    m.dns_record_type,
        "dns_expected_value": m.dns_expected_value,
        # Alert
        "alert_enabled":   m.alert_enabled,
        "alert_threshold": m.alert_threshold,
        # Live state
        "last_status":           m.last_status,
        "last_rtt_ms":           m.last_rtt_ms,
        "last_checked_at":       m.last_checked_at.isoformat() if m.last_checked_at else None,
        "last_status_change_at": m.last_status_change_at.isoformat() if m.last_status_change_at else None,
        "consecutive_failures":  m.consecutive_failures,
        # Computed
        "uptime_pct":   uptime.get("uptime_pct"),
        "avg_rtt_ms":   uptime.get("avg_rtt_ms"),
        "checks_24h":   uptime.get("checks_24h", 0),
        "ticks":        ticks,
        "created_at":   m.created_at.isoformat(),
    }


async def _push_config(device_id: str, db: AsyncSession):
    """Send updated monitor list to the agent."""
    from app.services.connection_manager import send_to_device
    rows = (await db.execute(
        select(Monitor).where(
            and_(Monitor.device_id == device_id, Monitor.enabled == True)
        )
    )).scalars().all()
    await send_to_device(device_id, {
        "type":     "monitor_config",
        "monitors": [_monitor_payload(m) for m in rows],
    })


def _monitor_payload(m: Monitor) -> dict:
    """Minimal dict sent to agent for each monitor."""
    d = {
        "id":       m.id,
        "type":     m.type,
        "target":   m.target,
        "interval": m.interval_seconds,
        "timeout":  m.timeout_seconds,
    }
    if m.port:
        d["port"] = m.port
    if m.type == MonitorType.HTTP:
        d["http_method"]          = m.http_method or "GET"
        d["http_expected_status"] = m.http_expected_status or 200
        d["http_keyword"]         = m.http_keyword
        d["http_ignore_ssl"]      = m.http_ignore_ssl
    if m.type == MonitorType.DNS:
        d["dns_record_type"]    = m.dns_record_type or "A"
        d["dns_expected_value"] = m.dns_expected_value
    return d
