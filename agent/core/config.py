"""
Configuration management.
All persistent state lives in /etc/msp-agent/config.json.
"""

import json
import os
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional

CONFIG_PATH = os.environ.get("MSP_CONFIG_PATH", "/etc/msp-agent/config.json")
DEFAULT_VERSION = "1.0.0"

logger = logging.getLogger(__name__)


@dataclass
class AgentConfig:
    # Server
    server_url: str = ""           # wss://yourserver.com
    api_base: str = ""             # https://yourserver.com

    # Identity — written on enrollment
    device_id: Optional[str] = None
    access_token: Optional[str] = None
    enrollment_secret: Optional[str] = None  # cleared after enrollment

    # Device info
    version: str = DEFAULT_VERSION
    hardware_id: str = ""
    pi_model: str = ""              # e.g. "Raspberry Pi Zero 2 W Rev 1.0", empty on non-Pi

    # Behaviour
    heartbeat_interval: int = 30   # seconds
    reconnect_min: int = 5         # seconds
    reconnect_max: int = 300       # seconds

    # Logging
    log_level: str = "INFO"
    log_file: str = "/var/log/msp-agent/agent.log"


def load_config() -> AgentConfig:
    if not os.path.exists(CONFIG_PATH):
        raise FileNotFoundError(
            f"Config not found at {CONFIG_PATH}. "
            "Run install.sh to provision this device."
        )
    with open(CONFIG_PATH) as f:
        data = json.load(f)
    config = AgentConfig(**{k: v for k, v in data.items() if k in AgentConfig.__dataclass_fields__})
    return config


def save_config(config: AgentConfig) -> None:
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(asdict(config), f, indent=2)
    os.replace(tmp, CONFIG_PATH)  # atomic
    logger.debug(f"Config saved to {CONFIG_PATH}")
