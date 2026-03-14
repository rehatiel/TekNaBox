"""
Full data model for the MSP remote diagnostics platform.

Tenant hierarchy: MSP → Customer → Site → Device
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum
from typing import Optional

from sqlalchemy import (
    BigInteger, Boolean, DateTime, Enum, Float, ForeignKey, Index, Integer,
    String, Text, UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def utcnow():
    return datetime.now(timezone.utc)


def new_uuid():
    return str(uuid.uuid4())


# ── Enums ─────────────────────────────────────────────────────────────────────

class DeviceRole(str, PyEnum):
    DIAGNOSTIC = "diagnostic"
    PROSPECTING = "prospecting"
    PENTEST = "pentest"


class DeviceStatus(str, PyEnum):
    PENDING = "pending"       # enrolled but not yet connected
    ACTIVE = "active"
    OFFLINE = "offline"
    REVOKED = "revoked"


class TaskStatus(str, PyEnum):
    QUEUED = "queued"
    DISPATCHED = "dispatched"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


class UpdateStatus(str, PyEnum):
    PENDING = "pending"
    NOTIFIED = "notified"
    DOWNLOADING = "downloading"
    APPLYING = "applying"
    COMPLETED = "completed"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"
    DEFERRED = "deferred"


class OperatorRole(str, PyEnum):
    SUPER_ADMIN = "super_admin"   # Anthropic/platform level
    MSP_ADMIN = "msp_admin"
    MSP_OPERATOR = "msp_operator"
    CUSTOMER_VIEWER = "customer_viewer"


class AuditAction(str, PyEnum):
    DEVICE_ENROLLED = "device_enrolled"
    DEVICE_REVOKED = "device_revoked"
    TASK_ISSUED = "task_issued"
    TASK_CANCELLED = "task_cancelled"
    UPDATE_DEPLOYED = "update_deployed"
    UPDATE_REVOKED = "update_revoked"
    CONFIG_CHANGED = "config_changed"
    OPERATOR_LOGIN = "operator_login"
    OPERATOR_CREATED = "operator_created"
    OPERATOR_REVOKED = "operator_revoked"


# ── Tenant Hierarchy ──────────────────────────────────────────────────────────

class MSPOrganization(Base):
    __tablename__ = "msp_organizations"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    customers: Mapped[list["CustomerOrganization"]] = relationship(back_populates="msp")
    operators: Mapped[list["Operator"]] = relationship(back_populates="msp")
    releases: Mapped[list["ClientRelease"]] = relationship(back_populates="msp")


class CustomerOrganization(Base):
    __tablename__ = "customer_organizations"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    msp: Mapped["MSPOrganization"] = relationship(back_populates="customers")
    sites: Mapped[list["Site"]] = relationship(back_populates="customer")

    __table_args__ = (
        UniqueConstraint("msp_id", "slug", name="uq_customer_msp_slug"),
        Index("ix_customer_msp_id", "msp_id"),
    )


class Site(Base):
    __tablename__ = "sites"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    customer_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    metadata_: Mapped[Optional[dict]] = mapped_column("metadata", JSONB)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    customer: Mapped["CustomerOrganization"] = relationship(back_populates="sites")
    devices: Mapped[list["Device"]] = relationship(back_populates="site")

    __table_args__ = (
        Index("ix_site_customer_id", "customer_id"),
        Index("ix_site_msp_id", "msp_id"),
    )


# ── Devices ───────────────────────────────────────────────────────────────────

class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    site_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sites.id"), nullable=False)
    customer_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)

    # Identity
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hardware_id: Mapped[Optional[str]] = mapped_column(String(255), unique=True)  # e.g. CPU serial
    fingerprint: Mapped[Optional[str]] = mapped_column(String(255))  # TLS cert fingerprint

    # State
    status: Mapped[DeviceStatus] = mapped_column(
        Enum(DeviceStatus, name="device_status"), default=DeviceStatus.PENDING
    )
    role: Mapped[DeviceRole] = mapped_column(
        Enum(DeviceRole, name="device_role"), default=DeviceRole.DIAGNOSTIC
    )

    # Enrollment
    enrollment_secret_hash: Mapped[Optional[str]] = mapped_column(String(64))
    enrolled_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[Optional[str]] = mapped_column(Text)

    # Connectivity
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_ip: Mapped[Optional[str]] = mapped_column(String(64))

    # Software
    current_version: Mapped[Optional[str]] = mapped_column(String(64))
    reported_arch: Mapped[Optional[str]] = mapped_column(String(32))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    site: Mapped["Site"] = relationship(back_populates="devices")
    customer: Mapped[Optional["CustomerOrganization"]] = relationship(foreign_keys=[customer_id])
    tasks: Mapped[list["Task"]] = relationship(back_populates="device")
    update_jobs: Mapped[list["DeviceUpdateJob"]] = relationship(back_populates="device")
    telemetry: Mapped[list["Telemetry"]] = relationship(back_populates="device")

    __table_args__ = (
        Index("ix_device_msp_id", "msp_id"),
        Index("ix_device_customer_id", "customer_id"),
        Index("ix_device_site_id", "site_id"),
        Index("ix_device_status", "status"),
    )


# ── Tasks / Commands ──────────────────────────────────────────────────────────

class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    issued_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("operators.id"))

    task_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[Optional[dict]] = mapped_column(JSONB)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus, name="task_status"), default=TaskStatus.QUEUED
    )

    # Idempotency
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(128), unique=True)

    # Timing
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    dispatched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=300)

    result: Mapped[Optional[dict]] = mapped_column(JSONB)
    error: Mapped[Optional[str]] = mapped_column(Text)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)

    device: Mapped["Device"] = relationship(back_populates="tasks")

    __table_args__ = (
        Index("ix_task_device_status", "device_id", "status"),
        Index("ix_task_msp_id", "msp_id"),
    )


# ── Telemetry & Results ───────────────────────────────────────────────────────

class Telemetry(Base):
    __tablename__ = "telemetry"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    customer_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"), nullable=False)

    task_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("tasks.id"))
    telemetry_type: Mapped[str] = mapped_column(String(64), nullable=False)  # heartbeat, scan_result, etc.
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())

    device: Mapped["Device"] = relationship(back_populates="telemetry")

    __table_args__ = (
        Index("ix_telemetry_device_received", "device_id", "received_at"),
        Index("ix_telemetry_msp_type", "msp_id", "telemetry_type"),
    )


# ── Client Releases & Updates ─────────────────────────────────────────────────

class ClientRelease(Base):
    __tablename__ = "client_releases"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    msp_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"))
    # msp_id=NULL means platform-wide release

    version: Mapped[str] = mapped_column(String(64), nullable=False)
    arch: Mapped[str] = mapped_column(String(32), nullable=False, default="armv6l")
    channel: Mapped[str] = mapped_column(String(32), default="stable")  # stable, beta, canary

    # Artifact
    artifact_path: Mapped[str] = mapped_column(String(512), nullable=False)
    artifact_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    artifact_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    signature: Mapped[Optional[str]] = mapped_column(Text)  # Ed25519 sig of artifact

    # Release notes and policy
    release_notes: Mapped[Optional[str]] = mapped_column(Text)
    min_supported_version: Mapped[Optional[str]] = mapped_column(String(64))
    is_mandatory: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[Optional[str]] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    uploaded_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("operators.id"))

    msp: Mapped[Optional["MSPOrganization"]] = relationship(back_populates="releases")
    update_jobs: Mapped[list["DeviceUpdateJob"]] = relationship(back_populates="release")

    __table_args__ = (
        UniqueConstraint("version", "arch", "channel", "msp_id", name="uq_release_version_arch_channel_msp"),
        Index("ix_release_channel_active", "channel", "is_active"),
    )


class UpdatePolicy(Base):
    """Phased rollout policies - can target MSP, customer, site, or device group."""
    __tablename__ = "update_policies"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    release_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("client_releases.id"), nullable=False)

    # Scope - any/all can be set; NULL means "all"
    target_customer_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"))
    target_site_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("sites.id"))
    target_device_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"))
    target_role: Mapped[Optional[DeviceRole]] = mapped_column(Enum(DeviceRole, name="device_role"))

    rollout_percent: Mapped[int] = mapped_column(Integer, default=100)  # 1-100
    is_forced: Mapped[bool] = mapped_column(Boolean, default=False)
    defer_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    created_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("operators.id"))


class DeviceUpdateJob(Base):
    """Per-device update execution record."""
    __tablename__ = "device_update_jobs"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    release_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("client_releases.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)

    status: Mapped[UpdateStatus] = mapped_column(
        Enum(UpdateStatus, name="update_status"), default=UpdateStatus.PENDING
    )
    from_version: Mapped[Optional[str]] = mapped_column(String(64))
    to_version: Mapped[str] = mapped_column(String(64), nullable=False)

    notified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    download_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    apply_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[Optional[str]] = mapped_column(Text)
    rollback_reason: Mapped[Optional[str]] = mapped_column(Text)

    device: Mapped["Device"] = relationship(back_populates="update_jobs")
    release: Mapped["ClientRelease"] = relationship(back_populates="update_jobs")

    __table_args__ = (
        UniqueConstraint("device_id", "release_id", name="uq_update_job_device_release"),
        Index("ix_update_job_device_status", "device_id", "status"),
    )


# ── Operators ─────────────────────────────────────────────────────────────────

class Operator(Base):
    __tablename__ = "operators"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    msp_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"))
    # msp_id=NULL = platform super-admin

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[OperatorRole] = mapped_column(
        Enum(OperatorRole, name="operator_role"), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    msp: Mapped[Optional["MSPOrganization"]] = relationship(back_populates="operators")


# ── Audit Log ─────────────────────────────────────────────────────────────────

class AuditLog(Base):
    """Immutable append-only audit trail."""
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    msp_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"))
    operator_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("operators.id"))
    device_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False))

    action: Mapped[AuditAction] = mapped_column(Enum(AuditAction, name="audit_action"), nullable=False)
    resource_type: Mapped[Optional[str]] = mapped_column(String(64))
    resource_id: Mapped[Optional[str]] = mapped_column(String(36))
    detail: Mapped[Optional[dict]] = mapped_column(JSONB)

    ip_address: Mapped[Optional[str]] = mapped_column(String(64))
    user_agent: Mapped[Optional[str]] = mapped_column(String(512))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=func.now()
    )

    __table_args__ = (
        Index("ix_audit_msp_created", "msp_id", "created_at"),
        Index("ix_audit_action", "action"),
        # Prevent deletions/updates via DB rule (applied in migration)
    )


# ── Uptime Monitoring ─────────────────────────────────────────────────────────

class MonitorTarget(Base):
    """A host/IP that a device should ping periodically (LAN monitoring)."""
    __tablename__ = "monitor_targets"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    customer_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"), nullable=False)

    label: Mapped[str] = mapped_column(String(128), nullable=False)       # friendly name
    host: Mapped[str] = mapped_column(String(255), nullable=False)         # IP or hostname
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    interval_seconds: Mapped[int] = mapped_column(Integer, default=30)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_monitor_target_device", "device_id"),
    )


class UptimeCheck(Base):
    """Result of a single ping check — from Pi (LAN) or server (WAN)."""
    __tablename__ = "uptime_checks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)

    # What was checked
    target: Mapped[str] = mapped_column(String(255), nullable=False)       # IP/host that was pinged
    source: Mapped[str] = mapped_column(String(16), nullable=False)        # "lan" (Pi) or "wan" (server)
    monitor_target_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("monitor_targets.id"))

    # Result
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    rtt_ms: Mapped[Optional[float]] = mapped_column()                      # None on failure
    packet_loss_pct: Mapped[float] = mapped_column(default=0.0)

    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=func.now())

    __table_args__ = (
        Index("ix_uptime_device_target_time", "device_id", "target", "checked_at"),
        Index("ix_uptime_msp_time", "msp_id", "checked_at"),
    )


# ── Active Directory Recon Reports ────────────────────────────────────────────

class ADReport(Base):
    """
    Stores the result of a run_ad_recon task as a structured report.
    One report per task execution — historical reports are kept.
    Credentials are NEVER stored here — only results.
    """
    __tablename__ = "ad_reports"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    task_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("tasks.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    customer_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"), nullable=False)

    # Domain info
    domain: Mapped[Optional[str]] = mapped_column(String(255))
    dc_ip: Mapped[Optional[str]] = mapped_column(String(64))
    functional_level: Mapped[Optional[str]] = mapped_column(String(128))

    # Full result blob — contains users, groups, findings, etc.
    report_data: Mapped[dict] = mapped_column(JSONB, nullable=False)

    # Quick-access summary fields (denormalised for list views)
    total_users: Mapped[Optional[int]] = mapped_column(Integer)
    domain_admins: Mapped[Optional[int]] = mapped_column(Integer)
    kerberoastable: Mapped[Optional[int]] = mapped_column(Integer)
    asrep_roastable: Mapped[Optional[int]] = mapped_column(Integer)
    findings_critical: Mapped[Optional[int]] = mapped_column(Integer)
    findings_high: Mapped[Optional[int]] = mapped_column(Integer)
    findings_medium: Mapped[Optional[int]] = mapped_column(Integer)
    # Extended summary fields (added Round 8)
    computer_count: Mapped[Optional[int]] = mapped_column(Integer)
    unconstrained_delegation: Mapped[Optional[int]] = mapped_column(Integer)
    laps_deployed: Mapped[Optional[bool]] = mapped_column(Boolean)
    laps_coverage_pct: Mapped[Optional[int]] = mapped_column(Integer)
    adminsdholder_count: Mapped[Optional[int]] = mapped_column(Integer)
    protected_users_count: Mapped[Optional[int]] = mapped_column(Integer)
    fine_grained_policies: Mapped[Optional[int]] = mapped_column(Integer)
    service_accounts: Mapped[Optional[int]] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_ad_report_device", "device_id"),
        Index("ix_ad_report_msp", "msp_id"),
    )


# ── Scan Findings ─────────────────────────────────────────────────────────────

class FindingSeverity(str, PyEnum):
    CRITICAL = "critical"
    HIGH     = "high"
    MEDIUM   = "medium"
    LOW      = "low"
    INFO     = "info"


class ScanFinding(Base):
    """
    Individual finding from a vuln scan or security audit.
    Auto-populated when run_vuln_scan or run_security_audit tasks complete.
    """
    __tablename__ = "scan_findings"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=new_uuid)
    device_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("devices.id"), nullable=False)
    task_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("tasks.id"), nullable=False)
    msp_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("msp_organizations.id"), nullable=False)
    customer_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("customer_organizations.id"), nullable=False)

    scan_type: Mapped[str] = mapped_column(String(32), nullable=False)   # "vuln_scan" | "security_audit"
    target_ip: Mapped[Optional[str]] = mapped_column(String(64))
    target_port: Mapped[Optional[int]] = mapped_column(Integer)
    protocol: Mapped[Optional[str]] = mapped_column(String(16))

    severity: Mapped[FindingSeverity] = mapped_column(
        Enum(FindingSeverity, name="finding_severity"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    script_id: Mapped[Optional[str]] = mapped_column(String(128))   # nmap script name
    cve_id: Mapped[Optional[str]] = mapped_column(String(32))
    cvss_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)  # CVSS base score (0.0-10.0)
    raw_output: Mapped[Optional[str]] = mapped_column(Text)

    # False positive / acknowledged tracking
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)
    acknowledged_by: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), ForeignKey("operators.id"))
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    notes: Mapped[Optional[str]] = mapped_column(Text)

    found_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_finding_device_severity", "device_id", "severity"),
        Index("ix_finding_msp_severity",    "msp_id",    "severity"),
        Index("ix_finding_task",            "task_id"),
    )
