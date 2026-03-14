"""
TCP tunnel over the device WebSocket channel.

Proxies raw TCP connections (RDP, VNC, SSH, etc.) to hosts on the device's LAN,
tunnelled transparently through the existing WebSocket connection to the server.

Protocol (server → agent):
  { "type": "tunnel_open",  "session_id": "...", "host": "192.168.1.5", "port": 3389 }
  { "type": "tunnel_data",  "session_id": "...", "data": "<base64>" }
  { "type": "tunnel_close", "session_id": "..." }

Protocol (agent → server):
  { "type": "tunnel_data",   "session_id": "...", "data": "<base64>" }
  { "type": "tunnel_closed", "session_id": "...", "reason": "..." }
"""

import asyncio
import base64
import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionManager

logger = logging.getLogger(__name__)

_sessions: dict[str, "_TunnelSession"] = {}

SAFE_HOST_RE = re.compile(r'^[a-zA-Z0-9.\-]+$')
MAX_SESSIONS = 8
READ_SIZE    = 8192


class _TunnelSession:
    def __init__(self, session_id: str, manager: "ConnectionManager", host: str, port: int):
        self.session_id = session_id
        self.manager    = manager
        self.host       = host
        self.port       = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._task: asyncio.Task | None = None

    async def start(self):
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port), timeout=10,
            )
        except Exception as e:
            await self._notify_closed(f"connect failed: {e}")
            _sessions.pop(self.session_id, None)
            return

        logger.info(f"tunnel: connected session={self.session_id} target={self.host}:{self.port}")
        self._task = asyncio.create_task(
            self._read_loop(), name=f"tunnel-{self.session_id[:8]}"
        )

    async def _read_loop(self):
        try:
            while True:
                data = await self._reader.read(READ_SIZE)
                if not data:
                    break
                await self.manager.send({
                    "type":       "tunnel_data",
                    "session_id": self.session_id,
                    "data":       base64.b64encode(data).decode(),
                })
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug(f"tunnel: read error: {e}")
        finally:
            await self._do_close("remote closed")

    async def write(self, data: bytes):
        if self._writer and not self._writer.is_closing():
            try:
                self._writer.write(data)
                await self._writer.drain()
            except Exception as e:
                logger.debug(f"tunnel: write error: {e}")

    async def _notify_closed(self, reason: str):
        try:
            await self.manager.send({
                "type":       "tunnel_closed",
                "session_id": self.session_id,
                "reason":     reason,
            })
        except Exception:
            pass

    async def _do_close(self, reason: str = "closed"):
        _sessions.pop(self.session_id, None)
        if self._writer:
            try:
                self._writer.close()
                await asyncio.wait_for(self._writer.wait_closed(), timeout=3)
            except Exception:
                pass
            self._writer = None
        await self._notify_closed(reason)
        logger.info(f"tunnel: session closed session={self.session_id} reason={reason}")

    async def close(self, reason: str = "operator closed"):
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        else:
            await self._do_close(reason)


# ── Public message handler ────────────────────────────────────────────────────

async def handle_tunnel_message(msg: dict, manager: "ConnectionManager"):
    msg_type   = msg.get("type")
    session_id = msg.get("session_id")

    if not session_id:
        logger.warning("tunnel: missing session_id")
        return

    if msg_type == "tunnel_open":
        if len(_sessions) >= MAX_SESSIONS:
            logger.warning(f"tunnel: max sessions ({MAX_SESSIONS}) reached")
            await manager.send({
                "type":       "tunnel_closed",
                "session_id": session_id,
                "reason":     "max sessions reached",
            })
            return

        host = str(msg.get("host", ""))
        port = int(msg.get("port", 3389))

        if not SAFE_HOST_RE.match(host):
            await manager.send({
                "type":       "tunnel_closed",
                "session_id": session_id,
                "reason":     f"invalid host: {host!r}",
            })
            return

        session = _TunnelSession(session_id, manager, host, port)
        _sessions[session_id] = session
        await session.start()

    elif msg_type == "tunnel_data":
        session = _sessions.get(session_id)
        if session:
            try:
                data = base64.b64decode(msg.get("data", ""))
                await session.write(data)
            except Exception as e:
                logger.debug(f"tunnel: bad data: {e}")

    elif msg_type == "tunnel_close":
        session = _sessions.get(session_id)
        if session:
            await session.close("operator closed")
