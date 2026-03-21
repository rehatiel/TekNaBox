"""
Admin & tenant management routes:
  - Bootstrap (create first super admin)
  - MSP CRUD
  - Operator CRUD
  - Customer CRUD
  - Site CRUD
"""

import re
import time
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

# ── Password policy ───────────────────────────────────────────────────────────
_MIN_PASSWORD_LEN = 12
_PASSWORD_RE = re.compile(
    r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{12,}$"
)

def _validate_password(password: str) -> None:
    """Enforce minimum password complexity. Raises HTTPException on failure."""
    if not _PASSWORD_RE.match(password):
        raise HTTPException(
            status_code=400,
            detail=(
                "Password must be at least 12 characters and contain uppercase, "
                "lowercase, a digit, and a special character."
            ),
        )
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func

from app.core.database import get_db
from app.core.auth import get_current_operator, require_role
from app.core.security import hash_password
from app.models.models import (
    MSPOrganization, CustomerOrganization, Site,
    Operator, OperatorRole, AuditAction,
)
from app.services.audit import write_audit

router = APIRouter(prefix="/v1", tags=["admin"])

_BOOTSTRAP_DONE = False  # in-process guard; DB uniqueness enforces it properly


# ── Bootstrap ─────────────────────────────────────────────────────────────────

class BootstrapRequest(BaseModel):
    email: str
    password: str


@router.post("/bootstrap")
async def bootstrap(body: BootstrapRequest, db: AsyncSession = Depends(get_db)):
    """
    Create the first super admin operator.
    Returns generic 404 after bootstrap to prevent endpoint enumeration.
    """
    count = (await db.execute(select(func.count()).select_from(Operator))).scalar()
    if count and count > 0:
        # Return 404 (not 409) — reveals nothing about platform state to an attacker
        raise HTTPException(status_code=404, detail="Not found")

    _validate_password(body.password)

    op = Operator(
        email=body.email,
        password_hash=hash_password(body.password),
        role=OperatorRole.SUPER_ADMIN,
        msp_id=None,
    )
    db.add(op)
    await db.commit()
    return {"status": "ok", "operator_id": op.id}


# ── MSPs ──────────────────────────────────────────────────────────────────────

class CreateMSPRequest(BaseModel):
    name: str
    slug: str


@router.post("/msps")
async def create_msp(
    body: CreateMSPRequest,
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    existing = (await db.execute(
        select(MSPOrganization).where(MSPOrganization.slug == body.slug)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Slug already taken")

    msp = MSPOrganization(name=body.name, slug=body.slug)
    db.add(msp)
    await db.commit()
    return {"id": msp.id, "name": msp.name, "slug": msp.slug}


@router.get("/msps")
async def list_msps(
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    msps = (await db.execute(select(MSPOrganization))).scalars().all()
    return [{"id": m.id, "name": m.name, "slug": m.slug, "is_active": m.is_active} for m in msps]


# ── Operators ─────────────────────────────────────────────────────────────────

class CreateOperatorRequest(BaseModel):
    email: str
    password: str
    role: OperatorRole
    msp_id: Optional[str] = None


@router.post("/operators")
async def create_operator(
    body: CreateOperatorRequest,
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN, OperatorRole.MSP_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    # MSP admins can only create operators within their own MSP
    if operator.role == OperatorRole.MSP_ADMIN:
        if body.msp_id and body.msp_id != operator.msp_id:
            raise HTTPException(status_code=403, detail="Cannot create operators for other MSPs")
        body.msp_id = operator.msp_id
        if body.role == OperatorRole.SUPER_ADMIN:
            raise HTTPException(status_code=403, detail="Cannot create super admins")

    _validate_password(body.password)

    existing = (await db.execute(
        select(Operator).where(Operator.email == body.email)
    )).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Email already in use")

    new_op = Operator(
        email=body.email,
        password_hash=hash_password(body.password),
        role=body.role,
        msp_id=body.msp_id,
    )
    db.add(new_op)
    await write_audit(
        db, AuditAction.OPERATOR_CREATED,
        msp_id=body.msp_id, operator_id=operator.id,
        detail={"email": body.email, "role": body.role},
    )
    await db.commit()
    return {"id": new_op.id, "email": new_op.email, "role": new_op.role, "msp_id": new_op.msp_id}


@router.delete("/operators/{operator_id}")
async def revoke_operator(
    operator_id: str,
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN, OperatorRole.MSP_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    from datetime import datetime, timezone
    target = (await db.execute(
        select(Operator).where(Operator.id == operator_id)
    )).scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Operator not found")
    if operator.role == OperatorRole.MSP_ADMIN and target.msp_id != operator.msp_id:
        raise HTTPException(status_code=403, detail="Access denied")

    target.is_active = False
    target.revoked_at = datetime.now(timezone.utc)
    await write_audit(
        db, AuditAction.OPERATOR_REVOKED,
        msp_id=target.msp_id, operator_id=operator.id,
        detail={"revoked_operator_id": operator_id},
    )
    await db.commit()
    return {"status": "revoked"}


# ── Customers ─────────────────────────────────────────────────────────────────

class CreateCustomerRequest(BaseModel):
    name: str
    slug: str


@router.post("/customers")
async def create_customer(
    body: CreateCustomerRequest,
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    customer = CustomerOrganization(
        msp_id=operator.msp_id,
        name=body.name,
        slug=body.slug,
    )
    db.add(customer)
    await db.commit()
    return {"id": customer.id, "name": customer.name, "slug": customer.slug, "msp_id": customer.msp_id}


@router.get("/customers")
async def list_customers(
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    customers = (await db.execute(
        select(CustomerOrganization).where(CustomerOrganization.msp_id == operator.msp_id)
    )).scalars().all()
    return [{"id": c.id, "name": c.name, "slug": c.slug} for c in customers]


# ── Sites ─────────────────────────────────────────────────────────────────────

class CreateSiteRequest(BaseModel):
    name: str
    customer_id: str
    description: Optional[str] = None


@router.post("/sites")
async def create_site(
    body: CreateSiteRequest,
    operator: Operator = Depends(require_role(OperatorRole.MSP_ADMIN, OperatorRole.MSP_OPERATOR)),
    db: AsyncSession = Depends(get_db),
):
    # Verify customer belongs to this MSP
    customer = (await db.execute(
        select(CustomerOrganization).where(
            and_(
                CustomerOrganization.id == body.customer_id,
                CustomerOrganization.msp_id == operator.msp_id,
            )
        )
    )).scalar_one_or_none()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")

    site = Site(
        customer_id=body.customer_id,
        msp_id=operator.msp_id,
        name=body.name,
        description=body.description,
    )
    db.add(site)
    await db.commit()
    return {"id": site.id, "name": site.name, "customer_id": site.customer_id}


@router.get("/sites")
async def list_sites(
    customer_id: Optional[str] = None,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    q = select(Site).where(Site.msp_id == operator.msp_id)
    if customer_id:
        q = q.where(Site.customer_id == customer_id)
    sites = (await db.execute(q)).scalars().all()
    return [{"id": s.id, "name": s.name, "customer_id": s.customer_id} for s in sites]


# ── List operators (added for user management UI) ─────────────────────────────

@router.get("/operators")
async def list_operators(
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN, OperatorRole.MSP_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    """List operators. MSP admins only see their own MSP's operators."""
    q = select(Operator)
    if operator.role == OperatorRole.MSP_ADMIN:
        q = q.where(Operator.msp_id == operator.msp_id)
    q = q.order_by(Operator.created_at)
    result = await db.execute(q)
    ops = result.scalars().all()
    return [
        {
            "id":           op.id,
            "email":        op.email,
            "role":         op.role,
            "msp_id":       op.msp_id,
            "is_active":    op.is_active,
            "mfa_enabled":  op.mfa_enabled,
            "last_login_at": op.last_login_at.isoformat() if op.last_login_at else None,
            "created_at":   op.created_at.isoformat(),
            "revoked_at":   op.revoked_at.isoformat() if op.revoked_at else None,
        }
        for op in ops
    ]


class UpdateOperatorRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[OperatorRole] = None
    is_active: Optional[bool] = None


@router.patch("/operators/{operator_id}")
async def update_operator(
    operator_id: str,
    body: UpdateOperatorRequest,
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN, OperatorRole.MSP_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    """Update operator email, password, or role."""
    from app.core.security import hash_password
    target = (await db.execute(
        select(Operator).where(Operator.id == operator_id)
    )).scalar_one_or_none()
    if not target:
        raise HTTPException(404, "Operator not found")
    if operator.role == OperatorRole.MSP_ADMIN:
        if target.msp_id != operator.msp_id:
            raise HTTPException(403, "Access denied")
        if body.role == OperatorRole.SUPER_ADMIN:
            raise HTTPException(403, "Cannot promote to super admin")

    if body.email is not None:
        target.email = body.email
    if body.password is not None and body.password:
        _validate_password(body.password)
        target.password_hash = hash_password(body.password)
    if body.role is not None:
        target.role = body.role
    if body.is_active is not None:
        target.is_active = body.is_active

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Email already in use")
    return {"id": target.id, "email": target.email, "role": target.role, "is_active": target.is_active}


# ── MFA / TOTP ────────────────────────────────────────────────────────────────

@router.post("/mfa/setup")
async def mfa_setup(
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """
    Generate a new TOTP secret for the calling operator.
    Returns the secret and provisioning URI for QR code display.
    Does NOT enable MFA — the operator must call /mfa/enable after scanning.
    """
    from app.core.security import generate_totp_secret, get_totp_uri
    secret = generate_totp_secret()
    operator.totp_secret = secret
    await db.commit()
    return {
        "secret": secret,
        "uri": get_totp_uri(secret, operator.email),
        "mfa_enabled": operator.mfa_enabled,
    }


class MFACodeRequest(BaseModel):
    code: str


@router.post("/mfa/enable")
async def mfa_enable(
    body: MFACodeRequest,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Verify the TOTP code from the authenticator app and enable MFA."""
    from app.core.security import verify_totp
    if not operator.totp_secret:
        raise HTTPException(400, "Call /mfa/setup first to generate a secret")
    if not verify_totp(operator.totp_secret, body.code):
        raise HTTPException(400, "Invalid TOTP code")
    operator.mfa_enabled = True
    await db.commit()
    return {"mfa_enabled": True}


@router.post("/mfa/disable")
async def mfa_disable(
    body: MFACodeRequest,
    operator: Operator = Depends(get_current_operator),
    db: AsyncSession = Depends(get_db),
):
    """Disable MFA. Requires current TOTP code to confirm."""
    from app.core.security import verify_totp
    if not operator.mfa_enabled or not operator.totp_secret:
        raise HTTPException(400, "MFA is not enabled")
    if not verify_totp(operator.totp_secret, body.code):
        raise HTTPException(400, "Invalid TOTP code")
    operator.mfa_enabled = False
    operator.totp_secret = None
    await db.commit()
    return {"mfa_enabled": False}


@router.delete("/operators/{operator_id}/mfa")
async def admin_disable_mfa(
    operator_id: str,
    operator: Operator = Depends(require_role(OperatorRole.SUPER_ADMIN, OperatorRole.MSP_ADMIN)),
    db: AsyncSession = Depends(get_db),
):
    """Admin: forcefully disable MFA for an operator (e.g. lost authenticator device)."""
    target = (await db.execute(
        select(Operator).where(Operator.id == operator_id)
    )).scalar_one_or_none()
    if not target:
        raise HTTPException(404, "Operator not found")
    if operator.role == OperatorRole.MSP_ADMIN and target.msp_id != operator.msp_id:
        raise HTTPException(403, "Access denied")
    target.mfa_enabled = False
    target.totp_secret = None
    await db.commit()
    return {"mfa_enabled": False}

