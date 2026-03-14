"""
Migration 0005 — Add customer_id to uptime_checks

Required because device_channel.py sets customer_id on UptimeCheck rows
created from monitor_result messages. Nullable so existing rows are unaffected.
"""

from alembic import op

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE uptime_checks
        ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customer_organizations(id);
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_uptime_customer_id ON uptime_checks (customer_id);
    """)


def downgrade():
    op.execute("DROP INDEX IF EXISTS ix_uptime_customer_id;")
    op.execute("ALTER TABLE uptime_checks DROP COLUMN IF EXISTS customer_id;")
