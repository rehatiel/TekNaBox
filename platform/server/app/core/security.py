from datetime import datetime, timedelta, timezone
from typing import Optional, Any
import secrets
import hashlib
import bcrypt
from jose import jwt, JWTError
from app.core.config import get_settings

settings = get_settings()

ALGORITHM = "HS256"


# ── Operator (human) auth ────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    # bcrypt has a 72-byte limit; truncate safely
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8")[:72], hashed.encode("utf-8"))


def create_operator_token(data: dict, expires_minutes: Optional[int] = None) -> str:
    exp = expires_minutes or settings.operator_token_expire_minutes
    payload = data.copy()
    payload["exp"] = int((datetime.now(timezone.utc) + timedelta(minutes=exp)).timestamp())
    payload["type"] = "operator"
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_operator_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])


# ── Device auth ──────────────────────────────────────────────────────────────

def create_device_token(device_id: str, tenant_id: str, expires_hours: Optional[int] = None) -> str:
    exp = expires_hours or settings.device_token_expire_hours
    payload = {
        "sub": device_id,
        "tid": tenant_id,
        "type": "device",
        "exp": int((datetime.now(timezone.utc) + timedelta(hours=exp)).timestamp()),
    }
    return jwt.encode(payload, settings.device_token_secret, algorithm=ALGORITHM)


def decode_device_token(token: str) -> dict:
    return jwt.decode(token, settings.device_token_secret, algorithms=[ALGORITHM])


# ── Enrollment secrets ───────────────────────────────────────────────────────

def generate_enrollment_secret() -> str:
    """One-time enrollment secret for device provisioning."""
    return secrets.token_urlsafe(32)


def hash_enrollment_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


# ── Artifact signing ─────────────────────────────────────────────────────────

def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
