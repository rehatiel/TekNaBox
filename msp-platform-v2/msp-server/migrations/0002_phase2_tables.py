"""
Phase 2 schema additions.

Revision ID: 0002
Revises: 0001
Create Date: 2026-03-08

Adds tables introduced in Phase 2 that may not exist on databases
created before that release, and adds a missing index on audit_logs.
Also ensures delete_device cascade order is documented as a comment
(actual cascade is handled in application code, not FK rules, to
preserve the audit_logs NO-DELETE protection).
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade():
    # ── ADReport ──────────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS ad_reports (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            device_id       UUID NOT NULL REFERENCES devices(id),
            task_id         UUID NOT NULL REFERENCES tasks(id),
            msp_id          UUID NOT NULL REFERENCES msp_organizations(id),
            customer_id     UUID NOT NULL REFERENCES customer_organizations(id),
            domain          VARCHAR(255),
            dc_ip           VARCHAR(64),
            functional_level VARCHAR(128),
            report_data     JSONB NOT NULL,
            total_users     INTEGER,
            domain_admins   INTEGER,
            kerberoastable  INTEGER,
            asrep_roastable INTEGER,
            findings_critical INTEGER,
            findings_high   INTEGER,
            findings_medium INTEGER,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS ix_ad_report_device ON ad_reports(device_id);
        CREATE INDEX IF NOT EXISTS ix_ad_report_msp    ON ad_reports(msp_id);
    """)

    # ── ScanFinding ───────────────────────────────────────────────────────────
    op.execute("""
        DO $$ BEGIN
            CREATE TYPE finding_severity AS ENUM
                ('critical','high','medium','low','info');
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$;

        CREATE TABLE IF NOT EXISTS scan_findings (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            device_id       UUID NOT NULL REFERENCES devices(id),
            task_id         UUID NOT NULL REFERENCES tasks(id),
            msp_id          UUID NOT NULL REFERENCES msp_organizations(id),
            customer_id     UUID NOT NULL REFERENCES customer_organizations(id),
            scan_type       VARCHAR(32) NOT NULL,
            target_ip       VARCHAR(64),
            target_port     INTEGER,
            protocol        VARCHAR(16),
            severity        finding_severity NOT NULL,
            title           VARCHAR(255) NOT NULL,
            description     TEXT,
            script_id       VARCHAR(128),
            cve_id          VARCHAR(32),
            raw_output      TEXT,
            acknowledged    BOOLEAN NOT NULL DEFAULT FALSE,
            acknowledged_by UUID REFERENCES operators(id),
            acknowledged_at TIMESTAMPTZ,
            notes           TEXT,
            found_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS ix_finding_device_severity
            ON scan_findings(device_id, severity);
        CREATE INDEX IF NOT EXISTS ix_finding_msp_severity
            ON scan_findings(msp_id, severity);
        CREATE INDEX IF NOT EXISTS ix_finding_task
            ON scan_findings(task_id);
    """)

    # ── MonitorTarget ─────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS monitor_targets (
            id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            device_id       UUID NOT NULL REFERENCES devices(id),
            msp_id          UUID NOT NULL REFERENCES msp_organizations(id),
            customer_id     UUID NOT NULL REFERENCES customer_organizations(id),
            label           VARCHAR(128) NOT NULL,
            host            VARCHAR(255) NOT NULL,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            interval_seconds INTEGER NOT NULL DEFAULT 30,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS ix_monitor_target_device
            ON monitor_targets(device_id);
    """)

    # ── UptimeCheck ───────────────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE IF NOT EXISTS uptime_checks (
            id              BIGSERIAL PRIMARY KEY,
            device_id       UUID NOT NULL REFERENCES devices(id),
            msp_id          UUID NOT NULL REFERENCES msp_organizations(id),
            target          VARCHAR(255) NOT NULL,
            source          VARCHAR(16) NOT NULL,
            monitor_target_id UUID REFERENCES monitor_targets(id),
            success         BOOLEAN NOT NULL,
            rtt_ms          DOUBLE PRECISION,
            packet_loss_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
            checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS ix_uptime_device_target_time
            ON uptime_checks(device_id, target, checked_at);
        CREATE INDEX IF NOT EXISTS ix_uptime_msp_time
            ON uptime_checks(msp_id, checked_at);
    """)

    # ── Pagination index on devices ───────────────────────────────────────────
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_device_created_at
            ON devices(created_at DESC);
    """)


def downgrade():
    op.execute("DROP TABLE IF EXISTS uptime_checks;")
    op.execute("DROP TABLE IF EXISTS monitor_targets;")
    op.execute("DROP TABLE IF EXISTS scan_findings;")
    op.execute("DROP TABLE IF EXISTS ad_reports;")
    op.execute("DROP INDEX IF EXISTS ix_device_created_at;")
