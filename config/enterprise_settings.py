"""Opt-in settings for the authenticated, PostgreSQL-backed enterprise portal."""
from __future__ import annotations

import os

from config.settings import *  # noqa: F401,F403


_secret = os.environ.get("TRADELOOM_ENTERPRISE_SECRET_KEY", "").strip()
if len(_secret) < 32:
    raise RuntimeError("TRADELOOM_ENTERPRISE_SECRET_KEY must be set to at least 32 characters")
if os.environ.get("TRADELOOM_DSH_EMBED", "0") == "1":
    raise RuntimeError("Enterprise service mode cannot be combined with DSH iframe embedding")
SECRET_KEY = _secret
DEBUG = False

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "workbench",
    "enterprise_portal",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "enterprise_portal.local_console_middleware.LocalConsoleSessionMiddleware",
    "enterprise_portal.email_login.EmailVerificationMiddleware",
    "enterprise_portal.middleware.EnterpriseRoleBoundaryMiddleware",
    "enterprise_portal.middleware.LivePolicySnapshotMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

TEMPLATES[0]["OPTIONS"]["context_processors"] = [
    "django.template.context_processors.request",
    "django.contrib.auth.context_processors.auth",
    "django.contrib.messages.context_processors.messages",
    "enterprise_portal.policy.live_policy_context",
]

ROOT_URLCONF = "config.enterprise_urls"
LOGIN_URL = "/accounts/login/"
LOGIN_REDIRECT_URL = "/enterprise/"
LOGOUT_REDIRECT_URL = "/accounts/login/"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
ALLOWED_HOSTS = [host.strip() for host in os.environ.get(
    "TRADELOOM_ENTERPRISE_ALLOWED_HOSTS", "127.0.0.1,localhost"
).split(",") if host.strip()]
if not ALLOWED_HOSTS or "*" in ALLOWED_HOSTS:
    raise RuntimeError("Enterprise mode requires explicit ALLOWED_HOSTS")
CSRF_TRUSTED_ORIGINS = [origin.strip() for origin in os.environ.get(
    "TRADELOOM_ENTERPRISE_CSRF_TRUSTED_ORIGINS", ""
).split(",") if origin.strip()]

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Lax"
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True

_https = os.environ.get("TRADELOOM_ENTERPRISE_HTTPS", "0") == "1"
_bind_host = os.environ.get("TRADELOOM_ENTERPRISE_BIND_HOST", "127.0.0.1").strip().lower()
if _bind_host not in {"127.0.0.1", "localhost", "::1"}:
    raise RuntimeError("Enterprise application processes must bind loopback behind a trusted HTTPS proxy")
if _https:
    if not CSRF_TRUSTED_ORIGINS or any(not origin.startswith("https://") for origin in CSRF_TRUSTED_ORIGINS):
        raise RuntimeError("HTTPS enterprise mode requires explicit https:// CSRF trusted origins")
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = int(os.environ.get("TRADELOOM_ENTERPRISE_HSTS_SECONDS", "0"))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = False
    SECURE_HSTS_PRELOAD = False

if os.environ.get("TRADELOOM_ENTERPRISE_DATABASE_ENGINE", "postgresql") != "postgresql":
    raise RuntimeError("Enterprise mode requires PostgreSQL")
_db_host = DATABASES["default"].get("HOST", "127.0.0.1").strip().lower()
if _db_host not in {"127.0.0.1", "localhost", "::1"}:
    if os.environ.get("TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE", "0") != "1":
        raise RuntimeError("Remote PostgreSQL requires TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE=1")
    _sslmode = os.environ.get("TRADELOOM_ENTERPRISE_DATABASE_SSLMODE", "")
    if _sslmode not in {"verify-full", "verify-ca", "require"}:
        raise RuntimeError("Remote PostgreSQL requires TLS via TRADELOOM_ENTERPRISE_DATABASE_SSLMODE")
    DATABASES["default"].setdefault("OPTIONS", {})["sslmode"] = _sslmode
