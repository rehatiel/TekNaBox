"""
MSP Remote Diagnostics Platform - Server
FastAPI application entry point.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.core.config import get_settings
from app.core.database import engine, Base, AsyncSessionLocal
from app.api.v1 import enrollment, device_channel, management, admin, monitoring, ad_recon, security, terminal, bandwidth, tunnel
from app.services.connection_manager import start_redis_subscriber

# ── Global rate limiter (used on sensitive endpoints) ────────────────────────
limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])

settings = get_settings()

structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(
        logging.getLevelName(settings.log_level)
    ),
)

logger = structlog.get_logger()


async def _auto_bootstrap():
    """
    Create the first super admin from env vars if:
      - BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD are set
      - No operators exist yet
    """
    if not settings.bootstrap_email or not settings.bootstrap_password:
        return

    from sqlalchemy import select, func
    from app.models.models import Operator, OperatorRole
    from app.core.security import hash_password

    async with AsyncSessionLocal() as db:
        count = (await db.execute(select(func.count()).select_from(Operator))).scalar()
        if count and count > 0:
            logger.info("bootstrap_skipped", reason="operators already exist")
            return

        op = Operator(
            email=settings.bootstrap_email,
            password_hash=hash_password(settings.bootstrap_password),
            role=OperatorRole.SUPER_ADMIN,
            msp_id=None,
        )
        db.add(op)
        await db.commit()
        logger.info("bootstrap_complete", email=settings.bootstrap_email)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables — checkfirst=True prevents errors on restart
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, checkfirst=True))

    # Auto-bootstrap super admin from env vars
    await _auto_bootstrap()

    # Start Redis subscriber for cross-worker WebSocket relay
    subscriber_task = asyncio.create_task(start_redis_subscriber())
    logger.info("server_started", environment=settings.environment)

    yield

    subscriber_task.cancel()
    await engine.dispose()
    logger.info("server_shutdown")


app = FastAPI(
    title="MSP Remote Diagnostics Platform",
    version="1.0.0",
    # Disable ALL API schema endpoints in production — leaks full API surface
    docs_url="/docs" if settings.environment != "production" else None,
    redoc_url=None,
    openapi_url="/openapi.json" if settings.environment != "production" else None,
    lifespan=lifespan,
)

# ── Rate limiting ─────────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With"],
)

# ── Security headers middleware ───────────────────────────────────────────────
@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    # Only set HSTS on HTTPS (nginx handles TLS; this covers the API layer)
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    # Tight CSP — API only serves JSON, no HTML
    response.headers["Content-Security-Policy"] = "default-src 'none'"
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.error("unhandled_exception", path=request.url.path, error=str(exc))
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


# Mount routers
app.include_router(admin.router)
app.include_router(enrollment.router)
app.include_router(device_channel.router)
app.include_router(management.router)
app.include_router(monitoring.router)
app.include_router(ad_recon.router)
app.include_router(security.router)
app.include_router(terminal.router)
app.include_router(bandwidth.router)
app.include_router(tunnel.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/metrics")
async def metrics(request: Request):
    """Protected metrics endpoint — requires operator auth."""
    from app.core.auth import get_current_operator
    from app.core.database import AsyncSessionLocal
    from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
    from fastapi import Security
    from app.services.connection_manager import connected_device_ids

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    token = auth_header.split(" ", 1)[1]
    try:
        from app.core.security import decode_operator_token
        from app.models.models import Operator
        payload = decode_operator_token(token)
        if payload.get("type") != "operator":
            raise ValueError()
        async with AsyncSessionLocal() as db:
            op = await db.get(Operator, payload.get("sub"))
            if not op or not op.is_active:
                raise ValueError()
    except Exception:
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})

    return {
        "connected_devices": len(connected_device_ids()),
    }
