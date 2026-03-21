"""
Remote terminal session handler.

Forks a PTY-backed shell and bridges stdin/stdout over the existing device
WebSocket channel. Supports two modes:

  Local shell (default):
    { "type": "terminal_open", "session_id": "...", "cols": 80, "rows": 24 }

  SSH to a LAN host (set ssh_host to enable):
    { "type": "terminal_open", "session_id": "...", "cols": 80, "rows": 24,
      "ssh_host": "192.168.1.10", "ssh_port": 22, "ssh_user": "admin" }
    The agent exec()s: ssh -t -p PORT USER@HOST
    Password prompts / host key prompts appear naturally in the terminal.

Protocol (server → agent):
  { "type": "terminal_open",   "session_id": "...", "cols": 80, "rows": 24,
    ["ssh_host": "...", "ssh_port": 22, "ssh_user": "root"] }
  { "type": "terminal_input",  "session_id": "...", "data": "<base64>" }
  { "type": "terminal_resize", "session_id": "...", "cols": 80, "rows": 24 }
  { "type": "terminal_close",  "session_id": "..." }

Protocol (agent → server):
  { "type": "terminal_output", "session_id": "...", "data": "<base64>", "done": false }
  { "type": "terminal_output", "session_id": "...", "data": "",          "done": true  }
"""

import asyncio
import base64
import logging
import os
import pty
import struct
import fcntl
import termios
import signal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionManager

logger = logging.getLogger(__name__)

# Active sessions: session_id → _TerminalSession
_sessions: dict[str, "_TerminalSession"] = {}

MAX_SESSIONS = 4          # prevent runaway terminal abuse
READ_SIZE    = 4096       # bytes per PTY read


class _TerminalSession:
    def __init__(
        self,
        session_id: str,
        manager: "ConnectionManager",
        cols: int,
        rows: int,
        ssh_host: str = "",
        ssh_port: int = 22,
        ssh_user: str = "root",
    ):
        self.session_id = session_id
        self.manager    = manager
        self.cols       = cols
        self.rows       = rows
        self.ssh_host   = ssh_host
        self.ssh_port   = ssh_port
        self.ssh_user   = ssh_user
        self._master_fd: int | None = None
        self._pid: int | None = None
        self._task: asyncio.Task | None = None

    async def start(self):
        loop = asyncio.get_running_loop()
        self._pid, self._master_fd = await loop.run_in_executor(None, self._fork_pty)
        self._set_winsize(self.cols, self.rows)
        self._task = asyncio.create_task(
            self._read_loop(),
            name=f"terminal-{self.session_id[:8]}",
        )
        logger.info(f"terminal: session opened session={self.session_id} pid={self._pid}")

    def _fork_pty(self) -> tuple[int, int]:
        pid, fd = pty.fork()
        if pid == 0:
            # Child — become the shell or SSH client
            if self.ssh_host:
                os.execvp("ssh", [
                    "ssh", "-t",
                    "-p", str(self.ssh_port),
                    "-o", "StrictHostKeyChecking=ask",
                    "-o", "ConnectTimeout=10",
                    f"{self.ssh_user}@{self.ssh_host}",
                ])
            else:
                os.execvp("/bin/bash", ["/bin/bash", "--login"])
        return pid, fd

    def _set_winsize(self, cols: int, rows: int):
        if self._master_fd is None:
            return
        try:
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
        except Exception as e:
            logger.debug(f"terminal: winsize error: {e}")

    async def _read_loop(self):
        loop = asyncio.get_running_loop()
        try:
            while True:
                try:
                    data = await loop.run_in_executor(None, self._read_master)
                except OSError:
                    # PTY closed (shell exited)
                    break
                if not data:
                    break
                encoded = base64.b64encode(data).decode()
                await self.manager.send({
                    "type":       "terminal_output",
                    "session_id": self.session_id,
                    "data":       encoded,
                    "done":       False,
                })
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"terminal: read loop error: {e}")
        finally:
            await self._close()

    def _read_master(self) -> bytes:
        """Blocking read from PTY master — runs in executor."""
        return os.read(self._master_fd, READ_SIZE)

    async def write(self, data: bytes):
        """Write stdin bytes to the PTY."""
        if self._master_fd is None:
            return
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, os.write, self._master_fd, data)
        except OSError as e:
            logger.debug(f"terminal: write error: {e}")

    async def resize(self, cols: int, rows: int):
        self.cols = cols
        self.rows = rows
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._set_winsize, cols, rows)

    async def _close(self):
        """Close the PTY and notify the server."""
        # Send EOF frame
        try:
            await self.manager.send({
                "type":       "terminal_output",
                "session_id": self.session_id,
                "data":       "",
                "done":       True,
            })
        except Exception:
            pass

        # Kill child process
        if self._pid:
            try:
                os.kill(self._pid, signal.SIGKILL)
                os.waitpid(self._pid, os.WNOHANG)
            except Exception:
                pass
            self._pid = None

        # Close master fd
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except Exception:
                pass
            self._master_fd = None

        _sessions.pop(self.session_id, None)
        logger.info(f"terminal: session closed session={self.session_id}")

    async def close(self):
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        else:
            await self._close()


# ── Public message handler ────────────────────────────────────────────────────

async def handle_terminal_message(msg: dict, manager: "ConnectionManager"):
    msg_type   = msg.get("type")
    session_id = msg.get("session_id")

    if not session_id:
        logger.warning("terminal: message missing session_id")
        return

    if msg_type == "terminal_open":
        if len(_sessions) >= MAX_SESSIONS:
            logger.warning(f"terminal: max sessions ({MAX_SESSIONS}) reached — rejecting {session_id}")
            await manager.send({
                "type":       "terminal_output",
                "session_id": session_id,
                "data":       base64.b64encode(b"\r\n[Max terminal sessions reached]\r\n").decode(),
                "done":       True,
            })
            return
        cols     = int(msg.get("cols", 80))
        rows     = int(msg.get("rows", 24))
        ssh_host = str(msg.get("ssh_host", ""))
        ssh_port = int(msg.get("ssh_port", 22))
        ssh_user = str(msg.get("ssh_user", "root"))
        session  = _TerminalSession(session_id, manager, cols, rows,
                                    ssh_host=ssh_host, ssh_port=ssh_port, ssh_user=ssh_user)
        _sessions[session_id] = session
        await session.start()

    elif msg_type == "terminal_input":
        session = _sessions.get(session_id)
        if session:
            raw = msg.get("data", "")
            try:
                data = base64.b64decode(raw)
                await session.write(data)
            except Exception as e:
                logger.debug(f"terminal: bad input data: {e}")

    elif msg_type == "terminal_resize":
        session = _sessions.get(session_id)
        if session:
            cols = int(msg.get("cols", 80))
            rows = int(msg.get("rows", 24))
            await session.resize(cols, rows)

    elif msg_type == "terminal_close":
        session = _sessions.get(session_id)
        if session:
            await session.close()
