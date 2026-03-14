"""
Browser ↔ Server ↔ Pi terminal bridge.

Flow:
  1. Operator opens WebSocket to /v1/devices/{id}/terminal?token=<operator_jwt>
  2. Server authenticates operator, checks device is active
  3. Server sends terminal_open to the Pi via existing device channel
  4. Pi spawns PTY, streams terminal_output back to server
  5. Server forwards terminal_output to browser WebSocket
  6. Browser keystrokes → server → terminal_input → Pi → PTY

Message format between server and browser (JSON over WebSocket):
  Server → Browser:  { "type": "output", "data": "<base64>" }
                     { "type": "closed" }
                     { "type": "error",  "message": "..." }
  Browser → Server:  { "type": "input",  "data": "<base64>" }
                     { "type": "resize", "cols": 80, "rows": 24 }
                     { "type": "close" }

The server bridges these to the Pi's terminal_* protocol.
Sessions are identified by a UUID generated per connection.
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

router = APIRouter(tags=["terminal"])
logger = logging.getLogger(__name__)

# Active terminal sessions: session_id → browser WebSocket
# Used to route terminal_output from device back to the right browser
_browser_sessions: dict[str, WebSocket] = {}


@router.websocket("/v1/devices/{device_id}/terminal")
async def device_terminal(
    ws: WebSocket,
    device_id: str,
    token: Optional[str] = Query(default=None),
    ticket: Optional[str] = Query(default=None),
):
    # ── Auth — accept short-lived WS ticket (preferred) or operator JWT ─────────
    operator_id = None
    msp_id      = None

    if ticket:
        # Preferred path: consume a short-lived single-use ticket
        entry = consume_ws_ticket(ticket)
        if not entry:
            await ws.close(code=4001, reason="Invalid or expired ticket")
            return
        operator_id = entry["operator_id"]
        msp_id      = entry["msp_id"]
    elif token:
        # Legacy fallback: direct JWT (still works but logs the token in URL)
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
        device = await db.get(Device, device_id)
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

    # ── Open session ──────────────────────────────────────────────────────────
    session_id = str(uuid.uuid4())
    await ws.accept()
    _browser_sessions[session_id] = ws

    logger.info(f"terminal_session_opened device={device_id} session={session_id} operator={operator_id}")

    # Tell the Pi to open a PTY
    await cm.send_to_device(device_id, {
        "type":       "terminal_open",
        "session_id": session_id,
        "cols":       80,
        "rows":       24,
    })

    try:
        async for raw in ws.iter_text():
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "input":
                await cm.send_to_device(device_id, {
                    "type":       "terminal_input",
                    "session_id": session_id,
                    "data":       msg.get("data", ""),
                })

            elif msg_type == "resize":
                await cm.send_to_device(device_id, {
                    "type":       "terminal_resize",
                    "session_id": session_id,
                    "cols":       msg.get("cols", 80),
                    "rows":       msg.get("rows", 24),
                })

            elif msg_type == "close":
                break

    except WebSocketDisconnect:
        pass
    finally:
        _browser_sessions.pop(session_id, None)
        # Tell Pi to clean up
        await cm.send_to_device(device_id, {
            "type":       "terminal_close",
            "session_id": session_id,
        })
        logger.info(f"terminal_session_closed session={session_id}")


async def route_terminal_output(session_id: str, data: str, done: bool):
    """
    Called by device_channel when a terminal_output message arrives from a Pi.
    Forwards the output to the browser WebSocket holding this session.
    """
    ws = _browser_sessions.get(session_id)
    if not ws:
        return

    try:
        if done:
            await ws.send_json({"type": "closed"})
            _browser_sessions.pop(session_id, None)
        else:
            await ws.send_json({"type": "output", "data": data})
    except Exception as e:
        logger.debug(f"terminal_forward_failed session={session_id}: {e}")
        _browser_sessions.pop(session_id, None)
