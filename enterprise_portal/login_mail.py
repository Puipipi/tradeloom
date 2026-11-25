"""Server-only SMTP configuration in the existing DPAPI vault; no secret read API."""
import json
import os
from contextlib import contextmanager
from django.conf import settings
from django.core.mail import EmailMessage, get_connection
from django.core.validators import validate_email
from .operations_store import CredentialStore


def store():
    return CredentialStore(os.environ.get("TRADELOOM_OPERATIONS_VAULT_DIR"))


def validate_configuration(value):
    if not isinstance(value, dict) or set(value) != {"host", "port", "username", "password", "from_email", "security"}:
        raise ValueError("请完整填写邮件服务器配置。")
    if value["security"] not in {"ssl", "starttls"}:
        raise ValueError("邮件服务器必须使用 SSL 或 STARTTLS。")
    if not isinstance(value["host"], str) or not value["host"] or any(c in value["host"] for c in "\r\n /@:"):
        raise ValueError("SMTP 主机名无效。")
    if type(value["port"]) is not int or not 1 <= value["port"] <= 65535:
        raise ValueError("SMTP 端口无效。")
    validate_email(value["from_email"])
    if any(not isinstance(value[k], str) or "\r" in value[k] or "\n" in value[k] or len(value[k]) > 4096 for k in ["username", "password", "from_email"]):
        raise ValueError("SMTP 配置无效。")
    if not value["username"] or not value["password"]:
        raise ValueError("请填写 SMTP 账号和授权密码。")
    return value


@contextmanager
def _write_lock(vault):
    # The Web and the native helper run in different processes.
    path = vault.root / ".smtp-configuration.lock"
    with path.open("a+b") as lock:
        lock.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def configure(value, *, replace=False):
    value = validate_configuration(value)
    vault = store()
    with _write_lock(vault):
        exists = vault._path("smtp_configuration").exists()
        if exists and not replace:
            raise ValueError("SMTP 已配置，请使用重置重新配置。")
        if replace and not exists:
            raise ValueError("SMTP 尚未配置，请刷新状态后保存。")
        try:
            vault.set("smtp_configuration", json.dumps(value), verify=True)
        except Exception:
            raise ValueError("SMTP 配置未通过本机加密校验，原配置已保留。") from None


def configuration_status():
    try:
        vault = store()
        path = vault._path("smtp_configuration")
        if not path.exists():
            return {"smtp_configured": False, "smtp_from_email": ""}
        value = validate_configuration(json.loads(vault._read_for_provider("smtp_configuration")))
        return {"smtp_configured": True, "smtp_from_email": value["from_email"]}
    except Exception:
        # Remain locked when a saved slot cannot be read; replacement is explicit.
        return {"smtp_configured": True, "smtp_from_email": ""}


def configured():
    status = configuration_status()
    return bool(status["smtp_from_email"])


def _send_message(email, subject, body):
    # Django locmem/test backends are available only through explicit test settings.
    backend = getattr(settings, "ENTERPRISE_LOGIN_MAIL_TEST_BACKEND", None)
    if backend:
        connection = get_connection(backend=backend)
        sender = "no-reply@example.invalid"
    else:
        value = validate_configuration(json.loads(store()._read_for_provider("smtp_configuration")))
        connection = get_connection(backend="django.core.mail.backends.smtp.EmailBackend", host=value["host"],
            port=value["port"], username=value["username"], password=value["password"],
            use_ssl=value["security"] == "ssl", use_tls=value["security"] == "starttls", timeout=10)
        sender = value["from_email"]
    message = EmailMessage(subject, body, sender, [email], connection=connection)
    if message.send(fail_silently=False) != 1:
        raise RuntimeError("Mail delivery unavailable")


def send_code(email, code):
    _send_message(email, "织贸登录验证码", f"您的织贸登录验证码是：{code}\n5 分钟内有效，仅可使用一次。若非本人操作，请忽略。")


def send_binding_code(email, code):
    _send_message(email, "织贸邮箱绑定验证码", f"您的织贸邮箱绑定验证码是：{code}\n仅用于确认新邮箱，5 分钟内有效。若非本人操作，请忽略。")
