from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache
from typing import Optional


class Settings(BaseSettings):
    # ── Core ──────────────────────────────────────────────────────────────────
    environment: str = "production"
    log_level: str = "INFO"
    secret_key: str
    device_token_secret: str

    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str
    db_password: Optional[str] = None

    # ── Redis ─────────────────────────────────────────────────────────────────
    redis_url: str
    redis_password: Optional[str] = None

    # ── Artifact storage ──────────────────────────────────────────────────────
    artifact_bucket: str = "/artifacts"

    # ── Bootstrap ─────────────────────────────────────────────────────────────
    # If set, a super admin is created automatically on first startup.
    # Ignored if the platform has already been bootstrapped.
    bootstrap_email: Optional[str] = None
    bootstrap_password: Optional[str] = None

    # ── Public API URL ─────────────────────────────────────────────────────────
    # Set this to the externally reachable API base URL (e.g. https://api.example.com).
    # Used to build enrollment bootstrap URLs. When unset, the URL is derived from
    # the incoming request headers, which can be wrong behind some reverse proxies.
    api_base_url: Optional[str] = None

    # ── Token expiry ──────────────────────────────────────────────────────────
    operator_token_expire_minutes: int = 60
    device_token_expire_hours: int = 24 * 7

    # ── Device heartbeat & monitoring ─────────────────────────────────────────
    device_heartbeat_interval: int = 30
    device_heartbeat_timeout: int = 90
    heartbeat_monitor_interval: int = 30

    # ── Task settings ─────────────────────────────────────────────────────────
    default_task_timeout_seconds: int = 300
    task_timeout_grace_seconds: int = 30
    task_watchdog_interval: int = 30

    # ── Agent reconnect behaviour ─────────────────────────────────────────────
    agent_reconnect_min_seconds: int = 5
    agent_reconnect_max_seconds: int = 300

    # ── Update policy ─────────────────────────────────────────────────────────
    default_update_check_interval_seconds: int = 300
    update_scheduler_interval: int = 300

    # ── CORS ──────────────────────────────────────────────────────────────────
    cors_origins: str = "*"

    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def cors_origins_list(self) -> list[str]:
        if self.cors_origins == "*":
            return ["*"]
        return [o.strip() for o in self.cors_origins.split(",")]


@lru_cache()
def get_settings() -> Settings:
    return Settings()
