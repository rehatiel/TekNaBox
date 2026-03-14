"""
Migration 0004 — Add cvss_score to scan_findings

Safe to run on existing DBs: uses ADD COLUMN IF NOT EXISTS.
"""

from alembic import op

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        ALTER TABLE scan_findings
        ADD COLUMN IF NOT EXISTS cvss_score FLOAT;
    """)


def downgrade():
    op.execute("ALTER TABLE scan_findings DROP COLUMN IF EXISTS cvss_score;")
