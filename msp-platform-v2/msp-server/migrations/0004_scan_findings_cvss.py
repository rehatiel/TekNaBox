"""
Migration 0004 — Add cvss_score to scan_findings

Safe to run on existing DBs: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
"""

from app.core.database import get_migration_connection


async def up():
    async with get_migration_connection() as op:
        op.execute("""
            ALTER TABLE scan_findings
            ADD COLUMN IF NOT EXISTS cvss_score FLOAT;
        """)


async def down():
    async with get_migration_connection() as op:
        op.execute("ALTER TABLE scan_findings DROP COLUMN IF EXISTS cvss_score;")
