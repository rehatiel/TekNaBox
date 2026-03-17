"""
Migration 0008 — Device scan records table + notes on discovered devices

Adds:
  - device_scan_records: persistent history of every scan run against a
    discovered device (port scan, banner grab, nmap, vuln, ssl, smb enum)
  - discovered_devices.notes: operator free-text notes per device
"""

from alembic import op

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE discovered_devices
            ADD COLUMN IF NOT EXISTS notes TEXT;
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS device_scan_records (
            id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            msp_id               UUID NOT NULL REFERENCES msp_organizations(id) ON DELETE CASCADE,
            discovered_device_id UUID NOT NULL REFERENCES discovered_devices(id) ON DELETE CASCADE,

            scan_type   VARCHAR(32)  NOT NULL,
            target_ip   VARCHAR(45),
            port_range  VARCHAR(128),
            task_id     UUID,

            status      VARCHAR(16)  NOT NULL DEFAULT 'completed',
            result      JSONB,
            error       TEXT,

            scanned_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS ix_device_scan_records_device
            ON device_scan_records (discovered_device_id);

        CREATE INDEX IF NOT EXISTS ix_device_scan_records_msp
            ON device_scan_records (msp_id);
    """)


def downgrade():
    op.execute("""
        DROP TABLE IF EXISTS device_scan_records;
        ALTER TABLE discovered_devices DROP COLUMN IF EXISTS notes;
    """)
