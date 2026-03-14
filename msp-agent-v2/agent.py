#!/usr/bin/env python3
"""
MSP Remote Diagnostics Agent
Connects outbound to the MSP server over WSS (port 443).
Runs on Raspberry Pi, Debian, Ubuntu — any Linux with Python 3.10+.

Entry point. Starts the connection loop and handles signals gracefully.
"""

import asyncio
import logging
import signal
import sys
import os

from core.config import load_config
from core.logger import setup_logging
from core.connection import ConnectionManager

logger = logging.getLogger(__name__)


async def main():
    try:
        config = load_config()
    except FileNotFoundError as e:
        # Print to stderr before logging is set up
        print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)

    setup_logging(config)

    manager = ConnectionManager(config)

    # Graceful shutdown on SIGTERM / SIGINT
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(manager.shutdown()))

    await manager.run()
    logger.info("Agent stopped cleanly")


if __name__ == "__main__":
    asyncio.run(main())
