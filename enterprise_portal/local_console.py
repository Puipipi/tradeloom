"""Opt-in Windows-account-bound, local HTTP console bootstrap.

The issuer is DPAPI CurrentUser protected; grants are random, DB-backed,
hashed and consumed under a row lock. Nothing trusts loopback as an identity.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import secrets
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.db import transaction
from django.core.exceptions import ObjectDoesNotExist
from django.utils import timezone


class LocalConsoleUnavailable(Exception):
    pass


def dpapi(data: bytes, *, protect: bool) -> bytes:
    if os.name != "nt":
        raise LocalConsoleUnavailable("Local console requires Windows DPAPI.")
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, result = Blob(len(data), buffer), Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if protect:
        operation = crypt.CryptProtectData
        operation.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        ok = operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    else:
        operation = crypt.CryptUnprotectData
        operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
        ok = operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
    if not ok:
        raise LocalConsoleUnavailable("Cannot access this installation's protected local issuer.")
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))


def installation():
    if os.environ.get("DJANGO_SETTINGS_MODULE") != "config.enterprise_settings":
        raise LocalConsoleUnavailable("Enterprise settings are required.")
    if getattr(settings, "SECURE_SSL_REDIRECT", False) or getattr(settings, "SESSION_COOKIE_SECURE", False):
        raise LocalConsoleUnavailable("Use normal authenticated console in HTTPS mode.")
    if getattr(settings, "SESSION_ENGINE", "django.contrib.sessions.backends.db") != "django.contrib.sessions.backends.db":
        raise LocalConsoleUnavailable("Database sessions are required.")
    if getattr(settings, "AUTHENTICATION_BACKENDS", ["django.contrib.auth.backends.ModelBackend"]) != ["django.contrib.auth.backends.ModelBackend"]:
        raise LocalConsoleUnavailable("The default enterprise authentication backend is required.")
    data_root = os.environ.get("TRADELOOM_ENTERPRISE_DATA_ROOT")
    if not data_root:
        data_root = str(Path(os.environ.get("LOCALAPPDATA", "")) / "TradeLoomEnterpriseServer")
    root = Path(data_root).resolve(strict=True)
    config = json.loads((root / "server-config.json").read_text(encoding="utf-8-sig"))
    if config.get("https_enabled") or Path(config["app_root"]).resolve() != Path(settings.BASE_DIR).resolve():
        raise LocalConsoleUnavailable("This is not the installed local HTTP application.")
    port = int(config["http_port"])
    if not 1024 <= port <= 65535:
        raise LocalConsoleUnavailable("Invalid local HTTP port.")
    return root, port


def issuer():
    root, port = installation()
    value = json.loads(dpapi((root / "secrets" / "local-console.dpapi").read_bytes(), protect=False))
    if value.get("root") != str(root) or value.get("version") != 1:
        raise LocalConsoleUnavailable("Protected issuer belongs to another installation.")
    return value, port


def technician(value):
    try:
        user = get_user_model().objects.get(pk=value["user_id"], username=value["username"])
    except ObjectDoesNotExist:
        raise LocalConsoleUnavailable("Dedicated technician identity is unavailable.") from None
    if (not user.is_active or user.is_staff or user.is_superuser or user.has_usable_password()
            or user.groups.exists() or set(user.get_all_permissions()) != {"enterprise_portal.use_server_operations"}):
        raise LocalConsoleUnavailable("Dedicated technician identity has changed; normal login is required.")
    return user


def enable():
    root, _ = installation()
    target = root / "secrets" / "local-console.dpapi"
    if target.exists():
        value, _ = issuer()
        technician(value)
        return
    permission = Permission.objects.get(content_type__app_label="enterprise_portal", codename="use_server_operations")
    username = "local_technician_" + secrets.token_hex(12)
    with transaction.atomic():
        user = get_user_model().objects.create_user(username=username, password=None)
        user.user_permissions.add(permission)
        value = {"version": 1, "root": str(root), "user_id": user.pk, "username": username,
                 "issuer": secrets.token_hex(32)}
        protected = dpapi(json.dumps(value).encode(), protect=True)
        # Exclusive create prevents concurrent enable from replacing another issuer.
        with target.open("xb") as handle:
            handle.write(protected)


def grant_key(token):
    return hashlib.sha256(("tradeloom-local-console:" + token).encode()).hexdigest()[:40]


def issue():
    value, port = issuer()
    user = technician(value)
    token = secrets.token_urlsafe(32)
    session = SessionStore()
    payload = {"local_console_issuer": hashlib.sha256(value["issuer"].encode()).hexdigest(),
               "local_console_user": user.pk}
    Session.objects.create(session_key=grant_key(token), session_data=session.encode(payload),
                           expire_date=timezone.now() + timedelta(seconds=60))
    return token, port


def consume(token):
    if not isinstance(token, str) or len(token) != 43:
        raise LocalConsoleUnavailable("Invalid or expired local console grant.")
    value, _ = issuer()
    with transaction.atomic():
        row = Session.objects.select_for_update().filter(session_key=grant_key(token)).first()
        if row is None:
            raise LocalConsoleUnavailable("Invalid or expired local console grant.")
        payload = row.get_decoded()
        # Successful redemption deletes atomically. Invalid/expired rows remain
        # unusable and are removed by Django's normal clearsessions maintenance.
        row.delete()
        if (row.expire_date <= timezone.now() or payload.get("local_console_user") != value["user_id"]
                or not secrets.compare_digest(payload.get("local_console_issuer", ""), hashlib.sha256(value["issuer"].encode()).hexdigest())):
            raise LocalConsoleUnavailable("Invalid or expired local console grant.")
        return technician(value)
