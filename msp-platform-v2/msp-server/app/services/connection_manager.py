"""
WebSocket connection manager.

Each connected device holds a WebSocket connection identified by device_id.
The manager supports:
- Registering / unregistering connections
- Sending JSON messages to specific devices
- Broadcasting to all devices of an MSP

For horizontal scaling, the manager uses Redis pub/sub so instances
on different workers can relay messages to connected devices.
"""

import asyncio
import json
import logging
from typing import Optional
from fastapi import WebSocket

import redis.asyncio as aioredis
from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Local connection registry  {device_id: WebSocket}
_connections: dict[str, WebSocket] = {}

# Persistent Redis client — initialised once, reused for all publish calls
_redis_client: Optional[aioredis.Redis] = None


def _get_redis() -> aioredis.Redis:
    """Return (or lazily create) a shared Redis client."""
    global _redis_client
    if _redis_client is None:
        _redis_client = aioredis.from_url(
            settings.redis_url,
            max_connections=20,
            decode_responses=False,
        )
    return _redis_client


async def register(device_id: str, ws: WebSocket) -> None:
    _connections[device_id] = ws
    logger.info("device_connected", extra={"device_id": device_id})


async def unregister(device_id: str) -> None:
    _connections.pop(device_id, None)
    logger.info("device_disconnected", extra={"device_id": device_id})


async def send_to_device(device_id: str, message: dict) -> bool:
    """
    Send message to a device. Returns True if delivered locally.
    Falls back to Redis pub/sub for cross-worker delivery.
    """
    ws = _connections.get(device_id)
    if ws:
        try:
            await ws.send_json(message)
            return True
        except Exception as e:
            logger.warning("ws_send_failed", extra={"device_id": device_id, "error": str(e)})
            await unregister(device_id)
    # Publish to Redis for other workers
    await _redis_publish(device_id, message)
    return False


async def _redis_publish(device_id: str, message: dict) -> None:
    try:
        r = _get_redis()
        await r.publish(f"device:{device_id}", json.dumps(message))
    except Exception as e:
        logger.error("redis_publish_failed", extra={"error": str(e)})


async def start_redis_subscriber() -> None:
    """
    Background task: subscribe to device channels via Redis pub/sub
    and forward messages to locally connected WebSockets.
    """
    r = aioredis.from_url(settings.redis_url)
    pubsub = r.pubsub()
    await pubsub.psubscribe("device:*")
    logger.info("redis_pubsub_subscriber_started")
    async for message in pubsub.listen():
        if message["type"] != "pmessage":
            continue
        try:
            channel: str = message["channel"].decode()
            device_id = channel.split(":", 1)[1]
            data = json.loads(message["data"])
            ws = _connections.get(device_id)
            if ws:
                await ws.send_json(data)
        except Exception as e:
            logger.warning("pubsub_relay_error", extra={"error": str(e)})


def connected_device_ids() -> list[str]:
    return list(_connections.keys())

