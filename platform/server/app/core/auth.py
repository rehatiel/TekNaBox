"""
FastAPI dependency injection for authentication and authorization.
Two token types: operator (human) and device.
"""

from typing import Optional
from fastapi import Depends, HTTPException, Header, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from jose import JWTError

from app.core.database import get_db
from app.core.security import decode_operator_token, decode_device_token
from app.models.models import Operator, Device, OperatorRole, DeviceStatus

bearer = HTTPBearer()


# ── Operator auth ─────────────────────────────────────────────────────────────

async def get_current_operator(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> Operator:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = decode_operator_token(creds.credentials)
        if payload.get("type") != "operator":
            raise credentials_exception
        operator_id: str = payload.get("sub")
        if not operator_id:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Check revocation blocklist
    jti = payload.get("jti")
    if jti:
        from app.services.connection_manager import _get_redis
        r = _get_redis()
        if await r.exists(f"blocklist:jti:{jti}"):
            raise credentials_exception

    result = await db.execute(select(Operator).where(Operator.id == operator_id))
    operator = result.scalar_one_or_none()
    if not operator or not operator.is_active:
        raise credentials_exception
    return operator


def require_role(*roles: OperatorRole):
    """Factory that returns a dependency requiring one of the given roles.
    SUPER_ADMIN always passes. MSP_ADMIN passes whenever MSP_OPERATOR is required.
    """
    async def _check(operator: Operator = Depends(get_current_operator)):
        if operator.role == OperatorRole.SUPER_ADMIN:
            return operator
        effective_roles = set(roles)
        if OperatorRole.MSP_OPERATOR in effective_roles:
            effective_roles.add(OperatorRole.MSP_ADMIN)
        if operator.role not in effective_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return operator
    return _check


def require_msp_access(msp_id: str):
    """Ensure operator belongs to the MSP or is super admin."""
    async def _check(operator: Operator = Depends(get_current_operator)):
        if operator.role == OperatorRole.SUPER_ADMIN:
            return operator
        if operator.msp_id != msp_id:
            raise HTTPException(status_code=403, detail="Access denied to this MSP")
        return operator
    return _check


# ── Device auth ───────────────────────────────────────────────────────────────

async def get_current_device(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> Device:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid device credentials",
    )
    try:
        payload = decode_device_token(creds.credentials)
        if payload.get("type") != "device":
            raise credentials_exception
        device_id: str = payload.get("sub")
    except JWTError:
        raise credentials_exception

    result = await db.execute(select(Device).where(Device.id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise credentials_exception
    if device.status == DeviceStatus.REVOKED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Device has been revoked",
        )
    return device
