"""
Atomic self-update mechanism.

Update flow:
  1. Server sends update_available message
  2. Agent reports status: downloading
  3. Downloads artifact to /tmp/msp-agent.new
  4. Verifies SHA256
  5. Reports status: applying
  6. Copies current agent to AGENT_BACKUP_PATH (persistent rollback)
  7. Atomically replaces /usr/local/bin/msp-agent
  8. Reports status: completed
  9. Restarts via systemd (systemctl restart msp-agent)

On any failure, rolls back and reports status: rolled_back
"""

import asyncio
import hashlib
import logging
import os
import shutil
import ssl
import subprocess
import urllib.parse
import urllib.request
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.connection import ConnectionManager
    from core.config import AgentConfig

logger = logging.getLogger(__name__)

AGENT_INSTALL_PATH  = os.environ.get("MSP_AGENT_PATH", "/usr/local/bin/msp-agent")
# Persistent backup — survives reboots unlike /tmp
AGENT_BACKUP_PATH   = "/opt/msp-agent/msp-agent.bak"
# Download to /opt/msp-agent (same filesystem as install target).
# /tmp would fail with EXDEV on os.replace() because PrivateTmp=yes in the
# systemd service makes /tmp a separate tmpfs mount.
AGENT_DOWNLOAD_PATH = "/opt/msp-agent/msp-agent.new"


async def handle_update_available(
    msg: dict,
    config: "AgentConfig",
    manager: "ConnectionManager",
) -> None:
    job_id        = msg.get("job_id")
    version       = msg.get("version")
    expected_sha  = msg.get("sha256")
    download_url  = msg.get("download_url")
    forced        = msg.get("forced", False)

    logger.info(f"Update available: {version} (job_id={job_id}, forced={forced})")

    # ── Validate download_url ─────────────────────────────────────────────────
    # Must be a relative path — no protocol overrides, no path traversal.
    if not download_url:
        await _report_status(manager, job_id, "failed", error="No download_url in message")
        return
    if "://" in str(download_url):
        await _report_status(manager, job_id, "failed",
                             error="download_url must be a relative path, not an absolute URL")
        return
    # Normalise and check for traversal
    normalised = os.path.normpath("/" + str(download_url).lstrip("/"))
    if ".." in normalised:
        await _report_status(manager, job_id, "failed",
                             error="download_url contains path traversal")
        return

    full_url = f"{config.api_base}{normalised}"

    # ── Download ──────────────────────────────────────────────────────────────
    await _report_status(manager, job_id, "downloading")
    try:
        data = await asyncio.get_running_loop().run_in_executor(
            None, _download_artifact, full_url, config.access_token
        )
    except Exception as e:
        logger.error(f"Download failed: {e}")
        await _report_status(manager, job_id, "failed", error=str(e))
        return

    # ── Verify SHA256 ─────────────────────────────────────────────────────────
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != expected_sha:
        err = f"SHA256 mismatch: expected {expected_sha}, got {actual_sha}"
        logger.error(err)
        await _report_status(manager, job_id, "failed", error=err)
        return

    logger.info(f"SHA256 verified: {actual_sha[:16]}…")

    with open(AGENT_DOWNLOAD_PATH, "wb") as f:
        f.write(data)
    os.chmod(AGENT_DOWNLOAD_PATH, 0o755)

    # ── Apply ─────────────────────────────────────────────────────────────────
    await _report_status(manager, job_id, "applying")
    try:
        _apply_update(version, config)
    except Exception as e:
        logger.error(f"Apply failed: {e} — rolling back")
        _rollback()
        await _report_status(manager, job_id, "rolled_back", rollback_reason=str(e))
        return

    await _report_status(manager, job_id, "completed", version=version)
    logger.info(f"Update to {version} applied — restarting service")

    await asyncio.sleep(2)
    _restart_service()


def _download_artifact(url: str, token: str) -> bytes:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
        data = resp.read()
    logger.info(f"Downloaded {len(data)} bytes from {url}")
    return data


def _apply_update(version: str, config: "AgentConfig") -> None:
    # Back up to persistent location (survives reboot, unlike /tmp)
    backup_dir = os.path.dirname(AGENT_BACKUP_PATH)
    os.makedirs(backup_dir, exist_ok=True)
    if os.path.exists(AGENT_INSTALL_PATH):
        shutil.copy2(AGENT_INSTALL_PATH, AGENT_BACKUP_PATH)
        logger.info(f"Backed up current agent to {AGENT_BACKUP_PATH}")

    os.replace(AGENT_DOWNLOAD_PATH, AGENT_INSTALL_PATH)
    os.chmod(AGENT_INSTALL_PATH, 0o755)

    # Verify the new binary is executable before declaring success
    try:
        subprocess.run(
            [AGENT_INSTALL_PATH, "--version"],
            check=True, timeout=10,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        raise RuntimeError(f"New binary failed self-test: {e}") from e

    logger.info(f"Agent binary updated to version {version}")

    from core.config import save_config
    config.version = version
    save_config(config)


def _rollback() -> None:
    if os.path.exists(AGENT_BACKUP_PATH):
        try:
            os.replace(AGENT_BACKUP_PATH, AGENT_INSTALL_PATH)
            os.chmod(AGENT_INSTALL_PATH, 0o755)
            logger.info("Rollback successful — previous agent restored")
        except Exception as e:
            logger.error(f"Rollback failed: {e}")
    else:
        logger.error("No backup found — cannot rollback")


def _restart_service() -> None:
    try:
        subprocess.run(
            ["systemctl", "restart", "msp-agent"],
            check=True, timeout=10,
        )
    except Exception as e:
        logger.error(f"Service restart failed: {e} — re-execing process")
        import sys
        os.execv(sys.executable, [sys.executable] + sys.argv)


async def _report_status(
    manager: "ConnectionManager",
    job_id: str,
    status: str,
    error: str = None,
    rollback_reason: str = None,
    version: str = None,
) -> None:
    msg = {"type": "update_status", "job_id": job_id, "status": status}
    if error:           msg["error"]            = error
    if rollback_reason: msg["rollback_reason"]  = rollback_reason
    if version:         msg["version"]          = version
    await manager.send(msg)
