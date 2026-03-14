"""
Live bandwidth monitor — streams per-process/per-IP bandwidth data to the server.

Protocol (over existing device WebSocket):

Server → Agent:
  { "type": "bandwidth_open",  "session_id": "...", "interface": "eth0", "mode": "process"|"ip" }
  { "type": "bandwidth_close", "session_id": "..." }

Agent → Server:
  { "type": "bandwidth_frame", "session_id": "...", "rows": [...], "ts": <epoch_float> }
  { "type": "bandwidth_closed","session_id": "...", "reason": "..." }

Row format (mode=process):
  { "pid": 1234, "name": "curl", "sent_kbps": 12.3, "recv_kbps": 45.6 }

Row format (mode=ip):
  { "ip": "192.168.1.5", "sent_kbps": 12.3, "recv_kbps": 45.6 }

Uses nethogs (process mode) or iftop -t (IP mode).
One agent can have multiple concurrent bandwidth sessions.
"""

import asyncio
import logging
import re
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionManager

logger = logging.getLogger(__name__)

# Active sessions: session_id → _BandwidthSession
_sessions: dict[str, "_BandwidthSession"] = {}

SAFE_IFACE_RE = re.compile(r'^[a-zA-Z0-9.\-_]+$')
MAX_DURATION  = 3600   # hard cap: 1 hour


class _BandwidthSession:
    def __init__(
        self,
        session_id: str,
        manager: "ConnectionManager",
        interface: str,
        mode: str,
        duration: int,
    ):
        self.session_id = session_id
        self.manager    = manager
        self.interface  = interface
        self.mode       = mode          # "process" or "ip"
        self.duration   = min(duration, MAX_DURATION)
        self._task: asyncio.Task | None = None
        self._proc: asyncio.subprocess.Process | None = None

    async def start(self):
        self._task = asyncio.create_task(
            self._run(),
            name=f"bw-{self.session_id[:8]}"
        )
        logger.info(f"bandwidth_session_opened session={self.session_id} iface={self.interface} mode={self.mode}")

    async def _run(self):
        try:
            if self.mode == "process":
                await self._run_nethogs()
            else:
                await self._run_iftop()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.warning(f"bandwidth session error: {e}")
        finally:
            await self._close(reason="session ended")

    # ── nethogs (process mode) ─────────────────────────────────────────────

    async def _run_nethogs(self):
        """
        nethogs -t outputs lines like:
            Refreshing:
            /usr/bin/curl/12345/    0.123   0.456
            unknown TCP             0.0     0.0
        We run it with -d 1 (1s refresh) and parse continuously.
        """
        cmd = [
            "nethogs",
            self.interface,
            "-t",       # troff / machine-readable output
            "-d", "1",  # refresh every 1s
            "-v", "3",  # show KB/s
        ]

        deadline = time.time() + self.duration

        try:
            self._proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except FileNotFoundError:
            logger.warning("nethogs not found — trying nettop fallback")
            await self._run_iftop()
            return

        rows_buf = []

        async for line in self._proc.stdout:
            if time.time() > deadline:
                break

            decoded = line.decode("utf-8", errors="replace").rstrip()

            if decoded.startswith("Refreshing:"):
                if rows_buf:
                    await self.manager.send({
                        "type":       "bandwidth_frame",
                        "session_id": self.session_id,
                        "rows":       rows_buf,
                        "ts":         time.time(),
                    })
                rows_buf = []
                continue

            # nethogs -t line: "name/pid\trecv\tsent" or "name\trecv\tsent"
            parts = decoded.split("\t")
            if len(parts) >= 3:
                name_pid = parts[0].strip()
                try:
                    recv_kbps = float(parts[1])
                    sent_kbps = float(parts[2])
                except ValueError:
                    continue

                # Parse name/pid
                pid  = None
                name = name_pid
                slash_parts = name_pid.rsplit("/", 2)
                if len(slash_parts) >= 2 and slash_parts[-1].isdigit():
                    pid  = int(slash_parts[-1])
                    # name is the executable basename
                    name = slash_parts[0].split("/")[-1] or name_pid

                if recv_kbps > 0 or sent_kbps > 0:
                    rows_buf.append({
                        "pid":       pid,
                        "name":      name,
                        "recv_kbps": round(recv_kbps, 2),
                        "sent_kbps": round(sent_kbps, 2),
                    })

        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3)
            except Exception:
                pass

    # ── iftop (IP mode) ────────────────────────────────────────────────────

    async def _run_iftop(self):
        """
        iftop -t -s N -i eth0 outputs a text snapshot every N seconds.
        We run it in 2-second bursts, parse the top-talkers table, and loop.
        """
        deadline = time.time() + self.duration

        while time.time() < deadline:
            cmd = [
                "iftop",
                "-t",           # text output (no ncurses)
                "-s", "2",      # snapshot after 2s
                "-n",           # no DNS lookups
                "-N",           # no port name resolution
                "-i", self.interface,
                "-L", "20",     # show top 20 pairs
            ]
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                stdout, _ = await asyncio.wait_for(
                    self._proc.communicate(), timeout=8
                )
                rows = _parse_iftop_text(stdout.decode("utf-8", errors="replace"))
                if rows:
                    await self.manager.send({
                        "type":       "bandwidth_frame",
                        "session_id": self.session_id,
                        "rows":       rows,
                        "ts":         time.time(),
                    })
            except (FileNotFoundError, asyncio.TimeoutError) as e:
                logger.warning(f"iftop error: {e}")
                break
            except asyncio.CancelledError:
                raise

            await asyncio.sleep(0.1)  # brief gap between snapshots

    # ── Cleanup ───────────────────────────────────────────────────────────

    async def close(self):
        if self._task and not self._task.done():
            self._task.cancel()
        await self._close(reason="operator closed")

    async def _close(self, reason: str = ""):
        _sessions.pop(self.session_id, None)

        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=3)
            except Exception:
                pass

        try:
            await self.manager.send({
                "type":       "bandwidth_closed",
                "session_id": self.session_id,
                "reason":     reason,
            })
        except Exception:
            pass

        logger.info(f"bandwidth_session_closed session={self.session_id} reason={reason}")


# ── Parser helpers ─────────────────────────────────────────────────────────────

def _parse_iftop_text(output: str) -> list[dict]:
    """
    Parse iftop -t output. Lines look like:
       1  192.168.1.5               =>      12.3Kb     24.5Kb     24.5Kb
                                   <=       1.23Kb      2.34Kb      2.34Kb
    We capture the '=>' (sent) and '<=' (recv) rates for the 2s column.
    """
    rows = {}
    lines = output.splitlines()
    last_ip = None
    rank    = 0

    for line in lines:
        # Sent line: "  N  <ip>  =>  X  X  X"
        m_sent = re.match(
            r'\s*(\d+)\s+([\d.]+)\s+=>\s+([\d.]+\s*[KMGk]?b/s|[\d.]+\s*[KMGk]?b)',
            line
        )
        if m_sent:
            rank    = int(m_sent.group(1))
            last_ip = m_sent.group(2)
            sent    = _parse_rate(m_sent.group(3))
            rows[last_ip] = {"ip": last_ip, "rank": rank, "sent_kbps": sent, "recv_kbps": 0.0}
            continue

        # Recv line: "           <=  X  X  X"
        m_recv = re.match(
            r'\s*<=\s+([\d.]+\s*[KMGk]?b/s|[\d.]+\s*[KMGk]?b)',
            line
        )
        if m_recv and last_ip and last_ip in rows:
            rows[last_ip]["recv_kbps"] = _parse_rate(m_recv.group(1))

    result = sorted(rows.values(), key=lambda r: r["sent_kbps"] + r["recv_kbps"], reverse=True)
    return result[:20]


def _parse_rate(s: str) -> float:
    """Convert '12.3Kb' / '1.2Mb' / '345b' → KB/s float."""
    s = s.strip().lower().rstrip("/s").strip()
    m = re.match(r'([\d.]+)\s*([kmg]?)b', s)
    if not m:
        return 0.0
    val    = float(m.group(1))
    suffix = m.group(2)
    if suffix == "k":
        return round(val, 2)
    if suffix == "m":
        return round(val * 1024, 2)
    if suffix == "g":
        return round(val * 1024 * 1024, 2)
    return round(val / 1024, 2)  # bytes → KB


# ── Public API (called from connection.py receive loop) ───────────────────────

async def handle_bandwidth_message(msg: dict, manager: "ConnectionManager"):
    msg_type   = msg.get("type")
    session_id = msg.get("session_id")
    if not session_id:
        return

    if msg_type == "bandwidth_open":
        if session_id in _sessions:
            await _sessions[session_id].close()

        interface = msg.get("interface", "eth0")
        mode      = msg.get("mode", "process")
        duration  = int(msg.get("duration", 300))

        if not SAFE_IFACE_RE.match(interface):
            logger.warning(f"bandwidth_open: invalid interface {interface!r}")
            return

        session = _BandwidthSession(session_id, manager, interface, mode, duration)
        _sessions[session_id] = session
        await session.start()

    elif msg_type == "bandwidth_close":
        session = _sessions.get(session_id)
        if session:
            await session.close()
