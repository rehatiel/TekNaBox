"""
Migration 0009 — Device sysinfo cache columns

Adds four columns to `devices` that are updated whenever a get_sysinfo task
completes successfully, so the device list can show live health metrics without
requiring a fresh task run.
"""

from alembic import op

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE devices
            ADD COLUMN IF NOT EXISTS last_cpu_temp_c  FLOAT,
            ADD COLUMN IF NOT EXISTS last_mem_pct      FLOAT,
            ADD COLUMN IF NOT EXISTS last_disk_pct     FLOAT,
            ADD COLUMN IF NOT EXISTS last_sysinfo_at   TIMESTAMPTZ;
    """)


def downgrade():
    op.execute("""
        ALTER TABLE devices
            DROP COLUMN IF EXISTS last_cpu_temp_c,
            DROP COLUMN IF EXISTS last_mem_pct,
            DROP COLUMN IF EXISTS last_disk_pct,
            DROP COLUMN IF EXISTS last_sysinfo_at;
    """)
