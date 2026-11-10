from __future__ import annotations

import os
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parents[1]

SECRET_KEY = os.environ.get("TRADELOOM_SECRET_KEY", "local-development-only")
DEBUG = os.environ.get("TRADELOOM_DEBUG", "1") == "1"
TRADELOOM_DSH_EMBED = os.environ.get("TRADELOOM_DSH_EMBED", "0") == "1"
TRADELOOM_ERPNEXT_BASE_URL = os.environ.get("TRADELOOM_ERPNEXT_BASE_URL", "")
TRADELOOM_ERPNEXT_INSTANCE_ID = os.environ.get("TRADELOOM_ERPNEXT_INSTANCE_ID", "")
TRADELOOM_ERPNEXT_API_KEY = os.environ.get("TRADELOOM_ERPNEXT_API_KEY", "")
TRADELOOM_ERPNEXT_API_SECRET = os.environ.get("TRADELOOM_ERPNEXT_API_SECRET", "")
if TRADELOOM_DSH_EMBED:
    _embed_hosts = [host.strip() for host in os.environ.get("TRADELOOM_DSH_ALLOWED_HOSTS", "").split(",") if host.strip()]
    if any(host == "*" for host in _embed_hosts):
        raise RuntimeError("TRADELOOM_DSH_ALLOWED_HOSTS must contain explicit hosts")
    ALLOWED_HOSTS = _embed_hosts or ["127.0.0.1", "localhost"]
    CSRF_TRUSTED_ORIGINS = [origin.strip() for origin in os.environ.get("TRADELOOM_DSH_CSRF_TRUSTED_ORIGINS", "").split(",") if origin.strip()]
else:
    ALLOWED_HOSTS = ["127.0.0.1", "localhost"]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "workbench",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
if TRADELOOM_DSH_EMBED:
    MIDDLEWARE.append("config.business_embed.EmbedFramePolicyMiddleware")
    X_FRAME_OPTIONS = "SAMEORIGIN"
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    }
]

WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("TRADELOOM_DB_NAME", "tradeloom"),
        "USER": os.environ.get("TRADELOOM_DB_USER", "tradeloom"),
        "PASSWORD": os.environ.get("TRADELOOM_DB_PASSWORD", ""),
        "HOST": os.environ.get("TRADELOOM_DB_HOST", "127.0.0.1"),
        "PORT": os.environ.get("TRADELOOM_DB_PORT", "5432"),
        "CONN_MAX_AGE": 30,
        "TEST": {
            "NAME": os.environ.get(
                "TRADELOOM_DB_TEST_NAME",
                "tradeloom_test",
            )
        },
    }
}

TEST_RUNNER = "workbench.testing.IsolatedTestDatabaseRunner"

LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "data" / "runtime" / "static"
MEDIA_URL = "/uploads/"
MEDIA_ROOT = Path(
    os.environ.get(
        "TRADELOOM_MEDIA_ROOT",
        str(BASE_DIR / "data" / "runtime" / "uploads"),
    )
)

TRADELOOM_ARTIFACT_ROOT = Path(
    os.environ.get(
        "TRADELOOM_ARTIFACT_ROOT",
        str(BASE_DIR / "data" / "runtime" / "artifacts"),
    )
)

_data_root_value = os.environ.get("TRADELOOM_DATA_ROOT")
TRADELOOM_DATA_ROOT = Path(_data_root_value).resolve() if _data_root_value else None
_intake_root_value = os.environ.get("TRADELOOM_INTAKE_ROOT")
TRADELOOM_INTAKE_ROOT = Path(_intake_root_value).resolve() if _intake_root_value else None
if TRADELOOM_INTAKE_ROOT is not None:
    if TRADELOOM_DATA_ROOT is None:
        raise RuntimeError("私有资料目录缺少受控数据根配置。")
    _expected_intake_root = (TRADELOOM_DATA_ROOT / "private" / "intake").resolve()
    if TRADELOOM_INTAKE_ROOT != _expected_intake_root:
        raise RuntimeError("私有资料目录不符合受控路径。")
    _media_root = MEDIA_ROOT.resolve()
    _static_root = STATIC_ROOT.resolve()
    if (
        TRADELOOM_INTAKE_ROOT == _media_root
        or TRADELOOM_INTAKE_ROOT in _media_root.parents
        or _media_root in TRADELOOM_INTAKE_ROOT.parents
        or TRADELOOM_INTAKE_ROOT == _static_root
        or TRADELOOM_INTAKE_ROOT in _static_root.parents
        or _static_root in TRADELOOM_INTAKE_ROOT.parents
    ):
        raise RuntimeError("私有资料目录不能位于公开媒体或静态目录。")

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
APPEND_SLASH = False
