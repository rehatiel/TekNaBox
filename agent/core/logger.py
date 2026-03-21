"""
Logging setup — writes to both systemd journal and a log file.
"""

import logging
import logging.handlers
import os
import sys
from core.config import AgentConfig


def setup_logging(config: AgentConfig) -> None:
    level = getattr(logging, config.log_level.upper(), logging.INFO)
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    # stdout → systemd journal picks this up automatically
    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(fmt)
    root.addHandler(stdout_handler)

    # Rotating file log
    try:
        os.makedirs(os.path.dirname(config.log_file), exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            config.log_file,
            maxBytes=5 * 1024 * 1024,  # 5MB
            backupCount=3,
        )
        file_handler.setFormatter(fmt)
        root.addHandler(file_handler)
    except Exception as e:
        logging.warning(f"Could not set up file logging: {e}")

    # Print a clean startup banner — visible in journalctl and log file
    import socket
    banner = (
        f"\n{'─' * 52}\n"
        f"  MSP Agent  v{config.version}\n"
        f"  Device : {config.device_id or 'unenrolled'}\n"
        f"  Host   : {socket.gethostname()}\n"
        f"  Server : {config.server_url}\n"
        f"  Log    : {config.log_level}\n"
        f"{'─' * 52}"
    )
    logging.getLogger(__name__).info(banner)
