"""
WebSocket endpoint for device ↔ server bidirectional communication.

Protocol:
  - Device connects with Authorization header or ?token= query param
  - Server sends queued tasks as JSON messages
  - Device sends telemetry, heartbeats, task results as JSON messages
  - Connection is long-lived; devices reconnect on drop with exponential backoff

Message envelope:
  { "type": "<message_type>", "id": "<correlation_id>", ...payload }

Inbound message types (device → server):
  heartbeat, task_result, telemetry, update_status

Outbound message types (server → device):
  task, update_available, config_update, kill
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, update as sql_update
from jose import JWTError

from app.core.database import get_db, AsyncSessionLocal
from app.core.security import decode_device_token
from app.models.models import (
    Device, DeviceStatus, Task, TaskStatus, Telemetry, AuditAction,
    DeviceUpdateJob, UpdateStatus,
)
from app.services import connection_manager as cm
from app.services.audit import write_audit
from app.services.update_service import record_update_state

router = APIRouter(prefix="/v1/devices", tags=["device-channel"])
logger = logging.getLogger(__name__)


def _fire(coro) -> asyncio.Task:
    """Create a fire-and-forget task that logs any unhandled exceptions."""
    task = asyncio.create_task(coro)
    def _on_done(t: asyncio.Task):
        if not t.cancelled() and t.exception():
            logger.error("Routing task failed", exc_info=t.exception())
    task.add_done_callback(_on_done)
    return task


async def _authenticate_ws(token: str) -> Optional[str]:
    """Returns device_id if token is valid, else None."""
    try:
        payload = decode_device_token(token)
        if payload.get("type") == "device":
            return payload.get("sub")
    except JWTError:
        pass
    return None


async def _get_pending_tasks(db: AsyncSession, device_id: str) -> list[Task]:
    result = await db.execute(
        select(Task).where(
            and_(
                Task.device_id == device_id,
                Task.status == TaskStatus.QUEUED,
            )
        ).order_by(Task.queued_at)
    )
    return result.scalars().all()


@router.websocket("/channel")
async def device_channel(
    ws: WebSocket,
    token: Optional[str] = Query(default=None),
):
    # Auth: prefer query param (for WebSocket; headers are hard to set in JS)
    device_id = None
    if token:
        device_id = await _authenticate_ws(token)

    if not device_id:
        await ws.close(code=4001, reason="Unauthorized")
        return

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Device).where(Device.id == device_id))
        device = result.scalar_one_or_none()
        if not device or device.status == DeviceStatus.REVOKED:
            await ws.close(code=4003, reason="Device revoked or not found")
            return

    await ws.accept()
    await cm.register(device_id, ws)

    try:
        # Push current config to device on connect
        from app.core.config import get_settings as _settings
        _s = _settings()
        await ws.send_json({
            "type": "config_update",
            "config": {
                "heartbeat_interval": _s.device_heartbeat_interval,
                "reconnect_min": _s.agent_reconnect_min_seconds,
                "reconnect_max": _s.agent_reconnect_max_seconds,
            }
        })
        # Flush pending tasks on connect
        async with AsyncSessionLocal() as db:
            pending = await _get_pending_tasks(db, device_id)
            for task in pending:
                await ws.send_json({
                    "type": "task",
                    "id": task.id,
                    "task_type": task.task_type,
                    "payload": task.payload or {},
                    "timeout_seconds": task.timeout_seconds,
                })
                task.status = TaskStatus.DISPATCHED
                task.dispatched_at = datetime.now(timezone.utc)
            await db.commit()

        # Main receive loop
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=120)
            except asyncio.TimeoutError:
                # Send keepalive ping
                await ws.send_json({"type": "ping"})
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("invalid_json_from_device", extra={"device_id": device_id})
                continue

            msg_type = msg.get("type")

            async with AsyncSessionLocal() as db:
                # Update last_seen
                await db.execute(
                    sql_update(Device)
                    .where(Device.id == device_id)
                    .values(last_seen_at=datetime.now(timezone.utc))
                )

                if msg_type == "heartbeat":
                    await _handle_heartbeat(db, device_id, msg)

                elif msg_type == "task_result":
                    await _handle_task_result(db, device_id, msg)

                elif msg_type == "telemetry":
                    await _handle_telemetry(db, device_id, device.msp_id, device.customer_id, msg)

                elif msg_type == "terminal_output":
                    from app.api.v1.terminal import route_terminal_output
                    _fire(route_terminal_output(
                        msg.get("session_id", ""),
                        msg.get("data", ""),
                        msg.get("done", False),
                    ))

                elif msg_type in ("bandwidth_frame", "bandwidth_closed"):
                    from app.api.v1.bandwidth import route_bandwidth_message
                    _fire(route_bandwidth_message(msg))

                elif msg_type in ("tunnel_data", "tunnel_closed"):
                    from app.api.v1.tunnel import route_tunnel_message
                    _fire(route_tunnel_message(
                        msg.get("session_id", ""),
                        msg_type,
                        msg.get("data", ""),
                        msg.get("reason", ""),
                    ))

                elif msg_type == "network_event":
                    await _handle_network_event(db, device_id, device.msp_id,
                                                device.customer_id, msg)

                elif msg_type == "update_status":
                    await _handle_update_status(db, device_id, msg)

                elif msg_type == "monitor_result":
                    await _handle_monitor_result(db, device_id, device.msp_id,
                                                 device.customer_id, msg)

                elif msg_type == "pong":
                    pass  # keepalive acknowledged

                else:
                    logger.debug("Unknown msg_type %s from device %s", msg_type, device_id)

                await db.commit()

    except WebSocketDisconnect:
        logger.info("device_ws_disconnected", extra={"device_id": device_id})
    except Exception as e:
        logger.error("ws_error", extra={"device_id": device_id, "error": str(e)})
    finally:
        await cm.unregister(device_id)
        async with AsyncSessionLocal() as db:
            await db.execute(
                sql_update(Device)
                .where(Device.id == device_id)
                .where(Device.status != DeviceStatus.REVOKED)
                .values(status=DeviceStatus.OFFLINE)
            )
            await db.commit()


async def _handle_heartbeat(db: AsyncSession, device_id: str, msg: dict) -> None:
    version = msg.get("version")
    if version:
        await db.execute(
            sql_update(Device)
            .where(Device.id == device_id)
            .values(current_version=version, status=DeviceStatus.ACTIVE)
        )


async def _handle_task_result(db: AsyncSession, device_id: str, msg: dict) -> None:
    task_id = msg.get("id")
    if not task_id:
        return
    result = await db.execute(
        select(Task).where(and_(Task.id == task_id, Task.device_id == device_id))
    )
    task = result.scalar_one_or_none()
    if not task:
        return
    success = msg.get("success", False)
    task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
    task.result = msg.get("result")
    task.error = msg.get("error")
    task.completed_at = datetime.now(timezone.utc)

    # Fetch device once for any post-processing
    device_obj = None
    if success and task.result and task.task_type in ("run_ad_recon", "run_vuln_scan", "run_security_audit"):
        device_result = await db.execute(select(Device).where(Device.id == device_id))
        device_obj = device_result.scalar_one_or_none()

    # Auto-save AD recon results as a report
    if success and task.task_type == "run_ad_recon" and task.result and device_obj:
        try:
            from app.api.v1.ad_recon import save_ad_report
            await save_ad_report(db, task, device_obj, task.result)
            logger.info(f"ad_report_saved task_id={task_id}")
        except Exception as e:
            logger.error(f"ad_report_save_failed: {e}")

    # Auto-save vuln scan / security audit findings
    if success and task.task_type in ("run_vuln_scan", "run_security_audit") and task.result and device_obj:
        try:
            from app.api.v1.security import save_scan_findings
            count = await save_scan_findings(db, task, device_obj, task.result)
            logger.info(f"scan_findings_saved count={count} task_id={task_id}")
        except Exception as e:
            logger.error(f"scan_findings_save_failed: {e}")


async def _handle_telemetry(
    db: AsyncSession, device_id: str, msp_id: str, customer_id: str, msg: dict
) -> None:
    telemetry_type = msg.get("telemetry_type", "generic")

    # Store all telemetry in the generic table
    telem = Telemetry(
        device_id=device_id,
        msp_id=msp_id,
        customer_id=customer_id,
        task_id=msg.get("task_id"),
        telemetry_type=telemetry_type,
        data=msg.get("data", {}),
    )
    db.add(telem)

    # uptime_ping → also write to uptime_checks for monitoring queries
    if telemetry_type == "uptime_ping":
        from app.models.models import UptimeCheck
        data = msg.get("data", {})
        results = data.get("results", [])
        if not results:
            return
        for ping in results:
            check = UptimeCheck(
                device_id=device_id,
                msp_id=msp_id,
                target=ping.get("target", ""),
                source="lan",
                success=ping.get("success", False),
                rtt_ms=ping.get("rtt_ms"),
                packet_loss_pct=ping.get("packet_loss_pct", 0.0 if ping.get("success") else 100.0),
                checked_at=datetime.now(timezone.utc),
            )
            db.add(check)


async def _handle_monitor_result(
    db: AsyncSession, device_id: str, msp_id: str, customer_id: str, msg: dict
) -> None:
    """Store LAN uptime check results sent by the agent's background monitor loop."""
    from app.models.models import UptimeCheck
    now     = datetime.now(timezone.utc)
    results = msg.get("results", [])
    for r in results:
        host = r.get("host", "")
        if not host:
            continue
        check = UptimeCheck(
            device_id=device_id,
            msp_id=msp_id,
            customer_id=customer_id,
            target=host,
            source="lan",
            success=r.get("success", False),
            rtt_ms=r.get("rtt_ms"),
            packet_loss_pct=0.0 if r.get("success") else 100.0,
            checked_at=now,
        )
        db.add(check)


async def _handle_network_event(
    db: AsyncSession, device_id: str, msp_id: str, customer_id: str, msg: dict
) -> None:
    """Store a network presence event (device joined/left/updated) in the telemetry table."""
    telem = Telemetry(
        device_id=device_id,
        msp_id=msp_id,
        customer_id=customer_id,
        telemetry_type="network_event",
        data={
            "event":  msg.get("event"),
            "device": msg.get("device", {}),
        },
    )
    db.add(telem)


async def _handle_update_status(db: AsyncSession, device_id: str, msg: dict) -> None:
    job_id = msg.get("job_id")
    status_str = msg.get("status")
    if not job_id or not status_str:
        return
    try:
        new_status = UpdateStatus(status_str)
    except ValueError:
        return
    await record_update_state(
        db, job_id, device_id, new_status,
        error=msg.get("error"),
        rollback_reason=msg.get("rollback_reason"),
    )
    # If completed, update device's current version
    if new_status == UpdateStatus.COMPLETED:
        version = msg.get("version")
        if version:
            await db.execute(
                sql_update(Device)
                .where(Device.id == device_id)
                .values(current_version=version)
            )
