"""
Device enrollment.
Called once on first boot if device_id is not yet set in config.
Posts enrollment secret to server, stores returned JWT.
"""

import logging
import urllib.request
import urllib.error
import json
import ssl

from core.config import AgentConfig, save_config
from core.hardware import get_cpu_serial, get_arch

logger = logging.getLogger(__name__)


def enroll(config: AgentConfig) -> bool:
    """
    Attempt to enroll with the server using the enrollment_secret.
    On success, populates config.device_id and config.access_token
    and clears the enrollment_secret.
    Returns True on success.
    """
    if not config.enrollment_secret:
        logger.error("No enrollment_secret in config — cannot enroll")
        return False

    hardware_id = get_cpu_serial()
    arch = get_arch()

    payload = json.dumps({
        "enrollment_secret": config.enrollment_secret,
        "hardware_id": hardware_id,
        "arch": arch,
        "current_version": config.version,
        "cert_fingerprint": None,
    }).encode()

    url = f"{config.api_base}/v1/enroll"
    logger.info(f"Enrolling with server at {url} (hardware_id={hardware_id})")

    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            data = json.loads(resp.read())

        config.device_id = data["device_id"]
        config.access_token = data["access_token"]
        config.hardware_id = hardware_id
        config.enrollment_secret = None  # consume it
        save_config(config)

        logger.info(f"Enrollment successful — device_id={config.device_id}")
        return True

    except urllib.error.HTTPError as e:
        body = e.read().decode()
        logger.error(f"Enrollment failed HTTP {e.code}: {body}")
        return False
    except Exception as e:
        logger.error(f"Enrollment error: {e}")
        return False


def refresh_token(config: AgentConfig) -> bool:
    """
    Refresh the device JWT. Called periodically by the connection manager.
    """
    url = f"{config.api_base}/v1/enroll/refresh"
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        data=b"{}",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.access_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
            data = json.loads(resp.read())
        config.access_token = data["access_token"]
        save_config(config)
        logger.info("Token refreshed successfully")
        return True
    except Exception as e:
        logger.warning(f"Token refresh failed: {e}")
        return False
