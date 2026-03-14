"""
Browser ↔ Server ↔ Agent TCP tunnel.

Proxies raw TCP connections (RDP, VNC, SSH, etc.) to hosts on the agent's LAN,
tunnelled transparently through the existing device WebSocket connection.

Flow:
  1. Operator opens WebSocket to /v1/devices/{id}/tunnel?token=...&host=HOST&port=PORT
  2. Server authenticates operator, checks device is active
  3. Server sends tunnel_open to the agent via the device channel
  4. Agent connects to HOST:PORT on its LAN and starts relaying bytes
  5. Agent → tunnel_data → Server → browser WebSocket
  6. Browser → tunnel_data → Server → Agent → TCP socket

Message format between server and browser (JSON over WebSocket):
  Server → Browser:  { "type": "data",   "data": "<base64>" }
                     { "type": "closed", "reason": "..." }
                     { "type": "error",  "message": "..." }
  Browser → Server:  { "type": "data",   "data": "<base64>" }
                     { "type": "close" }

To use with a native RDP/VNC client instead of a browser client, bridge with websocat:
  websocat -b tcp-l:localhost:13389 \\
    "wss://tekn-api.synhow.com/v1/devices/{id}/tunnel?token=TOKEN&host=HOST&port=3389"
  Then point your RDP client at localhost:13389.
"""

import asyncio
import json
import logging
import uuid
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from sqlalchemy import select
from jose import JWTError

from app.core.database import AsyncSessionLocal
from app.core.security import decode_operator_token
from app.models.models import Device, DeviceStatus, Operator
from app.services import connection_manager as cm
from app.api.v1.management import consume_ws_ticket

router = APIRouter(tags=["tunnel"])
logger = logging.getLogger(__name__)

# Active tunnel sessions: session_id → browser WebSocket
_browser_sessions: dict[str, WebSocket] = {}


@router.websocket("/v1/devices/{device_id}/tunnel")
async def device_tunnel(
    ws: WebSocket,
    device_id: str,
    host: str = Query(...),
    port: int = Query(...),
    token: Optional[str] = Query(default=None),
    ticket: Optional[str] = Query(default=None),
):
    # ── Auth ──────────────────────────────────────────────────────────────────
    operator_id = None
    msp_id      = None

    if ticket:
        entry = consume_ws_ticket(ticket)
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

    # ── Input validation ──────────────────────────────────────────────────────
    import re
    if not re.match(r'^[a-zA-Z0-9.\-]+$', host):
        await ws.close(code=4000, reason="Invalid host")
        return
    if not (1 <= port <= 65535):
        await ws.close(code=4000, reason="Invalid port")
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

    # ── Open tunnel ───────────────────────────────────────────────────────────
    session_id = str(uuid.uuid4())
    await ws.accept()
    _browser_sessions[session_id] = ws

    logger.info(f"tunnel_opened device={device_id} session={session_id} "
                f"target={host}:{port} operator={operator_id}")

    # Tell the agent to open a TCP connection to the target
    await cm.send_to_device(device_id, {
        "type":       "tunnel_open",
        "session_id": session_id,
        "host":       host,
        "port":       port,
    })

    try:
        async for raw in ws.iter_text():
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "data":
                await cm.send_to_device(device_id, {
                    "type":       "tunnel_data",
                    "session_id": session_id,
                    "data":       msg.get("data", ""),
                })
            elif msg_type == "close":
                break

    except WebSocketDisconnect:
        pass
    finally:
        _browser_sessions.pop(session_id, None)
        await cm.send_to_device(device_id, {
            "type":       "tunnel_close",
            "session_id": session_id,
        })
        logger.info(f"tunnel_closed session={session_id}")


async def route_tunnel_message(session_id: str, msg_type: str, data: str = "", reason: str = ""):
    """
    Called by device_channel when a tunnel_data or tunnel_closed message arrives from the agent.
    Forwards to the browser WebSocket holding this session.
    """
    ws = _browser_sessions.get(session_id)
    if not ws:
        return

    try:
        if msg_type == "tunnel_closed":
            await ws.send_json({"type": "closed", "reason": reason})
            _browser_sessions.pop(session_id, None)
        else:
            await ws.send_json({"type": "data", "data": data})
    except Exception as e:
        logger.debug(f"tunnel_forward_failed session={session_id}: {e}")
        _browser_sessions.pop(session_id, None)
