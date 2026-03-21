"""
WebSocket connection manager.

Maintains a persistent WSS connection to the server.
Handles:
  - Automatic reconnection with exponential backoff
  - Heartbeat keepalive
  - Inbound message routing to the dispatcher
  - Outbound message queuing during disconnects
  - Token refresh
  - Clean shutdown on SIGTERM / SIGINT
"""

import asyncio
import json
import logging
import time
from typing import Optional

import websockets
import websockets.exceptions

from core.config import AgentConfig, save_config
from core.enrollment import enroll, refresh_token
from core.dispatcher import dispatch
from core.hardware import get_uptime_seconds, get_cpu_temp, get_memory_info, get_disk_info

logger = logging.getLogger(__name__)

TOKEN_REFRESH_INTERVAL = 6 * 24 * 3600  # 6 days
MAX_CONCURRENT_TASKS   = 3              # prevent Pi from being overwhelmed by parallel tasks


class ConnectionManager:
    def __init__(self, config: AgentConfig):
        self.config = config
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._outbound: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._shutdown = False
        self._shutdown_event = asyncio.Event()
        self._last_token_refresh = time.time()
        self._background_tasks: set[asyncio.Task] = set()
        self._config_lock = asyncio.Lock()
        self._task_semaphore = asyncio.Semaphore(MAX_CONCURRENT_TASKS)

    # ── Public API ────────────────────────────────────────────────────────────

    async def send(self, msg: dict):
        try:
            self._outbound.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning("Outbound queue full — dropping message")

    def send_nowait(self, msg: dict):
        try:
            self._outbound.put_nowait(msg)
        except asyncio.QueueFull:
            logger.warning("Outbound queue full — dropping message")

    async def shutdown(self):
        if self._shutdown:
            return
        logger.info("Shutting down agent")
        self._shutdown = True
        self._shutdown_event.set()

        tasks_to_cancel = [t for t in self._background_tasks if not t.done()]
        if tasks_to_cancel:
            logger.debug(f"Cancelling {len(tasks_to_cancel)} background task(s)")
            for t in tasks_to_cancel:
                t.cancel()
            await asyncio.gather(*tasks_to_cancel, return_exceptions=True)

        if self._ws and not self._ws.closed:
            try:
                await asyncio.wait_for(self._ws.close(), timeout=5)
            except Exception:
                pass

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def run(self):
        if not self.config.device_id or not self.config.access_token:
            if not self.config.enrollment_secret:
                logger.error(
                    "No device_id, access_token, or enrollment_secret in config. "
                    "Run install.sh with a valid --secret to provision this device."
                )
                await self._interruptible_sleep(60)
                if not self._shutdown:
                    return await self.run()
                return

            logger.info("Device not enrolled — starting enrollment")
            if not await asyncio.get_running_loop().run_in_executor(None, enroll, self.config):
                logger.error("Enrollment failed — will retry in 60s")
                await self._interruptible_sleep(60)
                if not self._shutdown:
                    return await self.run()
                return
        else:
            logger.info(f"Device already enrolled as {self.config.device_id} — skipping enrollment")

        backoff = self.config.reconnect_min

        while not self._shutdown:
            try:
                await self._connect_and_run()
                backoff = self.config.reconnect_min
            except Exception as e:
                if self._shutdown:
                    break
                logger.warning(f"Connection lost: {e} — reconnecting in {backoff}s")
                await self._interruptible_sleep(backoff)
                backoff = min(backoff * 2, self.config.reconnect_max)

    # ── Connection lifecycle ──────────────────────────────────────────────────

    async def _connect_and_run(self):
        url = (
            f"{self.config.server_url}/v1/devices/channel"
            f"?token={self.config.access_token}"
        )
        logger.info(f"Connecting to {self.config.server_url}")

        async with websockets.connect(
            url,
            ping_interval=None,
            ping_timeout=None,
            close_timeout=5,
            max_size=10 * 1024 * 1024,
        ) as ws:
            self._ws = ws
            logger.info("Connected to server")

            from core.monitor import run_monitor
            from core.net_watcher import run_net_watcher
            try:
                await asyncio.gather(
                    self._receive_loop(ws),
                    self._send_loop(ws),
                    self._heartbeat_loop(ws),
                    self._token_refresh_loop(),
                    run_monitor(self.config, self),
                    run_net_watcher(self),
                )
            except asyncio.CancelledError:
                pass

    # ── Loops ─────────────────────────────────────────────────────────────────

    async def _receive_loop(self, ws):
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("Received invalid JSON from server")
                continue

            msg_type = msg.get("type")
            logger.debug(f"← {msg_type}")

            if msg_type == "ping":
                await self.send({"type": "pong"})
            elif msg_type == "kill":
                reason = msg.get("reason", "server revoked device")
                logger.warning(f"Kill signal received: {reason} — shutting down")
                await self.shutdown()
                return
            elif msg_type in ("task", "update_available", "config_update"):
                self._spawn(self._handle_message(msg))
            elif msg_type in ("terminal_open", "terminal_input", "terminal_resize", "terminal_close"):
                from core.terminal import handle_terminal_message
                self._spawn(handle_terminal_message(msg, self))
            elif msg_type in ("bandwidth_open", "bandwidth_close"):
                from core.bandwidth import handle_bandwidth_message
                self._spawn(handle_bandwidth_message(msg, self))
            elif msg_type in ("tunnel_open", "tunnel_data", "tunnel_close"):
                from core.tcp_tunnel import handle_tunnel_message
                self._spawn(handle_tunnel_message(msg, self))
            elif msg_type == "net_watch_config":
                from core.net_watcher import update_net_watch_config
                self._spawn(update_net_watch_config(msg))
            else:
                logger.debug(f"Unhandled message type: {msg_type}")

    async def _handle_message(self, msg: dict):
        if msg.get("type") == "task":
            # Throttle concurrent tasks to protect Pi resources
            async with self._task_semaphore:
                result = await dispatch(msg, self.config, self)
                if result:
                    await self.send(result)
        else:
            result = await dispatch(msg, self.config, self)
            if result:
                await self.send(result)

    async def _send_loop(self, ws):
        while not self._shutdown:
            try:
                msg = await asyncio.wait_for(self._outbound.get(), timeout=1.0)
                await ws.send(json.dumps(msg))
                logger.debug(f"→ {msg.get('type')}")
            except asyncio.TimeoutError:
                continue
            except websockets.exceptions.ConnectionClosed:
                raise

    async def _heartbeat_loop(self, ws):
        while not self._shutdown:
            await self._interruptible_sleep(self.config.heartbeat_interval)
            if self._shutdown:
                break
            heartbeat = {
                "type": "heartbeat",
                "version": self.config.version,
                "uptime_seconds": get_uptime_seconds(),
                "cpu_temp_c": get_cpu_temp(),
                "memory": get_memory_info(),
                "disk": get_disk_info(),
                "active_tasks": MAX_CONCURRENT_TASKS - self._task_semaphore._value,
                "pi_model": self.config.pi_model or None,
            }
            await self.send(heartbeat)

    async def _token_refresh_loop(self):
        while not self._shutdown:
            await self._interruptible_sleep(3600)
            if self._shutdown:
                break
            if time.time() - self._last_token_refresh > TOKEN_REFRESH_INTERVAL:
                logger.info("Refreshing device token")
                async with self._config_lock:
                    ok = await asyncio.get_running_loop().run_in_executor(
                        None, refresh_token, self.config
                    )
                if ok:
                    self._last_token_refresh = time.time()

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _interruptible_sleep(self, seconds: float):
        try:
            await asyncio.wait_for(self._shutdown_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task
