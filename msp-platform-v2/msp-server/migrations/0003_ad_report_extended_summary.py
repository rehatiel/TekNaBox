"""
Migration 0003 — Extended AD report summary columns

Adds the new denormalised summary columns to ad_reports that correspond
to the expanded fields returned by the agent's run_ad_recon task (Round 8).

All columns are nullable — existing reports simply have NULL for these fields,
which the UI handles gracefully with "—" fallbacks.
"""

from alembic import op


def upgrade():
    op.execute("""
        ALTER TABLE ad_reports
            ADD COLUMN IF NOT EXISTS computer_count           INTEGER,
            ADD COLUMN IF NOT EXISTS unconstrained_delegation INTEGER,
            ADD COLUMN IF NOT EXISTS laps_deployed            BOOLEAN,
            ADD COLUMN IF NOT EXISTS laps_coverage_pct        INTEGER,
            ADD COLUMN IF NOT EXISTS adminsdholder_count      INTEGER,
            ADD COLUMN IF NOT EXISTS protected_users_count    INTEGER,
            ADD COLUMN IF NOT EXISTS fine_grained_policies    INTEGER,
            ADD COLUMN IF NOT EXISTS service_accounts         INTEGER;
    """)


def downgrade():
    op.execute("""
        ALTER TABLE ad_reports
            DROP COLUMN IF EXISTS computer_count,
            DROP COLUMN IF EXISTS unconstrained_delegation,
            DROP COLUMN IF EXISTS laps_deployed,
            DROP COLUMN IF EXISTS laps_coverage_pct,
            DROP COLUMN IF EXISTS adminsdholder_count,
            DROP COLUMN IF EXISTS protected_users_count,
            DROP COLUMN IF EXISTS fine_grained_policies,
            DROP COLUMN IF EXISTS service_accounts;
    """)
