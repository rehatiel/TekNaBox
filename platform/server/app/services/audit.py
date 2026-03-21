from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.models import AuditLog, AuditAction


async def write_audit(
    db: AsyncSession,
    action: AuditAction,
    *,
    msp_id: Optional[str] = None,
    operator_id: Optional[str] = None,
    device_id: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    detail: Optional[dict] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> None:
    """Append an immutable audit record. Fire-and-forget within a transaction."""
    log = AuditLog(
        action=action,
        msp_id=msp_id,
        operator_id=operator_id,
        device_id=device_id,
        resource_type=resource_type,
        resource_id=resource_id,
        detail=detail,
        ip_address=ip_address,
        user_agent=user_agent,
    )
    db.add(log)
    # Caller is responsible for committing the surrounding transaction
