"""
Migration 0007 — Add port scan fields to discovered_devices

Stores the most recent port scan result (open ports list + timestamp) directly
on each discovered device record so operators can see open services at a glance.
"""

from alembic import op

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE discovered_devices
            ADD COLUMN IF NOT EXISTS open_ports       JSONB,
            ADD COLUMN IF NOT EXISTS ports_scanned_at TIMESTAMPTZ;
    """)


def downgrade():
    op.execute("""
        ALTER TABLE discovered_devices
            DROP COLUMN IF EXISTS open_ports,
            DROP COLUMN IF EXISTS ports_scanned_at;
    """)
