"""
Browser ↔ Server ↔ Pi live bandwidth monitor bridge.

Flow:
  1. Operator opens WebSocket to /v1/devices/{id}/bandwidth?token=<jwt>
  2. Server authenticates operator, checks device is active
  3. Server sends bandwidth_open to Pi via device channel
  4. Pi runs nethogs/iftop, streams bandwidth_frame messages back
  5. Server forwards frames to browser WebSocket as JSON
  6. On disconnect, server sends bandwidth_close to Pi

Message format (server ↔ browser):
  Server → Browser:  { "type": "frame",   "rows": [...], "ts": <epoch> }
                     { "type": "closed",  "reason": "..." }
                     { "type": "error",   "message": "..." }
  Browser → Server:  { "type": "close" }

Row format (mode=process):  { "pid": 1234, "name": "curl", "sent_kbps": 12.3, "recv_kbps": 45.6 }
Row format (mode=ip):       { "ip": "192.168.1.5", "sent_kbps": 12.3, "recv_kbps": 45.6 }
"""

import asyncio
import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from jose import JWTError
import redis.asyncio as aioredis

from app.core.database import AsyncSessionLocal
from app.core.config import get_settings
from app.core.security import decode_operator_token
from app.models.models import Device, DeviceStatus, Operator
from app.services import connection_manager as cm
from app.api.v1.management import consume_ws_ticket

router = APIRouter(tags=["bandwidth"])
logger = logging.getLogger(__name__)

# Active bandwidth sessions: session_id → browser WebSocket
_browser_sessions: dict[str, WebSocket] = {}


async def _redis_bw_relay(session_id: str, ws: WebSocket):
    """
    Subscribe to Redis for bandwidth frames published by other uvicorn workers.
    Runs as a background task for the lifetime of the browser WebSocket.
    """
    r = aioredis.from_url(get_settings().redis_url)
    pubsub = r.pubsub()
    await pubsub.subscribe(f"bandwidth_out:{session_id}")
    try:
        async for message in pubsub.listen():
            if session_id not in _browser_sessions:
                break
            if message["type"] != "message":
                continue
            try:
                await ws.send_json(json.loads(message["data"]))
            except Exception:
                break
    except asyncio.CancelledError:
        pass
    finally:
        try:
            await pubsub.unsubscribe(f"bandwidth_out:{session_id}")
        except Exception:
            pass
        await r.aclose()


@router.websocket("/v1/devices/{device_id}/bandwidth")
async def device_bandwidth(
    ws: WebSocket,
    device_id: str,
    token: Optional[str] = Query(default=None),
    ticket: Optional[str] = Query(default=None),
    interface: str = Query(default="eth0"),
    mode: str = Query(default="process"),   # "process" or "ip"
    duration: int = Query(default=300),     # max session seconds
):
    # ── Auth — accept short-lived WS ticket (preferred) or operator JWT ─────────
    operator_id = None
    msp_id      = None

    if ticket:
        entry = await consume_ws_ticket(ticket)
        if not entry:
            await ws.close(code=4001, reason="Invalid or expired ticket")
            return
        operator_id = entry["operator_id"]
        msp_id      = entry["msp_id"]
    elif token:
        try:
            payload = decode_operator_token(token)
            if payload.get("type") != "operator":
                raise ValueError("Not an operator token")
            operator_id = payload.get("sub")
            msp_id      = payload.get("msp_id")
        except (JWTError, ValueError):
            await ws.close(code=4001, reason="Invalid token")
            return
    else:
        await ws.close(code=4001, reason="Missing auth")
        return

    # ── Device check ──────────────────────────────────────────────────────────
    async with AsyncSessionLocal() as db:
        device   = await db.get(Device, device_id)
        operator = await db.get(Operator, operator_id)

    if not device or device.msp_id != msp_id:
        await ws.close(code=4004, reason="Device not found")
        return
    if device.status != DeviceStatus.ACTIVE:
        await ws.close(code=4003, reason="Device is not active")
        return
    if not operator or not operator.is_active:
        await ws.close(code=4001, reason="Operator not authorized")
        return

    # ── Validate params ───────────────────────────────────────────────────────
    import re
    if not re.match(r'^[a-zA-Z0-9.\-_]+$', interface):
        await ws.close(code=4000, reason="Invalid interface name")
        return
    if mode not in ("process", "ip"):
        mode = "process"
    duration = max(10, min(duration, 3600))

    # ── Open session ──────────────────────────────────────────────────────────
    session_id = str(uuid.uuid4())
    await ws.accept()
    _browser_sessions[session_id] = ws
    relay_task = asyncio.create_task(_redis_bw_relay(session_id, ws))

    logger.info(
        f"bandwidth_session_opened device={device_id} "
        f"session={session_id} operator={operator_id} "
        f"iface={interface} mode={mode}"
    )

    # Tell Pi to start streaming
    await cm.send_to_device(device_id, {
        "type":       "bandwidth_open",
        "session_id": session_id,
        "interface":  interface,
        "mode":       mode,
        "duration":   duration,
    })

    try:
        # Browser can only send { "type": "close" } — just wait for it
        async for raw in ws.iter_text():
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "close":
                break
    except WebSocketDisconnect:
        pass
    finally:
        relay_task.cancel()
        _browser_sessions.pop(session_id, None)
        await cm.send_to_device(device_id, {
            "type":       "bandwidth_close",
            "session_id": session_id,
        })
        logger.info(f"bandwidth_session_closed session={session_id}")


async def route_bandwidth_message(msg: dict):
    """
    Called by device_channel when bandwidth_frame or bandwidth_closed
    arrives from the Pi. Forwards to the browser holding this session.
    If the session is on a different worker, publishes to Redis for that worker.
    """
    session_id = msg.get("session_id", "")
    ws = _browser_sessions.get(session_id)
    msg_type = msg.get("type")

    if ws:
        try:
            if msg_type == "bandwidth_frame":
                await ws.send_json({
                    "type": "frame",
                    "rows": msg.get("rows", []),
                    "ts":   msg.get("ts", 0),
                })
            elif msg_type == "bandwidth_closed":
                await ws.send_json({
                    "type":   "closed",
                    "reason": msg.get("reason", ""),
                })
                _browser_sessions.pop(session_id, None)
        except Exception as e:
            logger.debug(f"bandwidth_forward_failed session={session_id}: {e}")
            _browser_sessions.pop(session_id, None)
    else:
        # Session is on another worker — relay via Redis pub/sub
        from app.services.connection_manager import _get_redis
        if msg_type == "bandwidth_frame":
            out = {"type": "frame", "rows": msg.get("rows", []), "ts": msg.get("ts", 0)}
        elif msg_type == "bandwidth_closed":
            out = {"type": "closed", "reason": msg.get("reason", "")}
        else:
            return
        try:
            await _get_redis().publish(f"bandwidth_out:{session_id}", json.dumps(out))
        except Exception as e:
            logger.debug(f"bandwidth_redis_relay_failed session={session_id}: {e}")
