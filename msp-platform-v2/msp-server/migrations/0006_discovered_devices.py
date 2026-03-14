"""
Migration 0006 — Create discovered_devices table

Persistent history of all devices seen in network discovery scans.
One row per MAC per MSP; updated on each scan (upsert by mac+msp_id).
"""

from alembic import op

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE TABLE IF NOT EXISTS discovered_devices (
            id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            msp_id            UUID         NOT NULL REFERENCES msp_organizations(id),
            source_device_id  UUID         REFERENCES devices(id),
            mac               VARCHAR(17)  NOT NULL,
            ip                VARCHAR(45),
            vendor            VARCHAR(128),
            hostname          VARCHAR(255),
            label             VARCHAR(128),
            known             BOOLEAN      NOT NULL DEFAULT FALSE,
            first_seen        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            last_seen         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_discovered_device_msp_mac UNIQUE (msp_id, mac)
        );
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_discovered_device_msp
            ON discovered_devices (msp_id);
    """)


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_discovered_device_msp;")
    op.execute("DROP TABLE IF EXISTS discovered_devices;")
