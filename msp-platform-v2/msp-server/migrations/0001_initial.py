"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2025-01-01 00:00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    # All tables are created by SQLAlchemy via create_all in dev.
    # In production, Alembic manages schema migrations.
    # This migration represents the baseline schema.

    # Protect audit_logs from modification
    op.execute("""
        CREATE RULE no_update_audit AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
        CREATE RULE no_delete_audit AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
    """)

    # Indexes for performance
    op.execute("""
        CREATE INDEX IF NOT EXISTS ix_telemetry_device_type_received 
        ON telemetry(device_id, telemetry_type, received_at DESC);
    """)


def downgrade():
    op.execute("DROP RULE IF EXISTS no_update_audit ON audit_logs;")
    op.execute("DROP RULE IF EXISTS no_delete_audit ON audit_logs;")
