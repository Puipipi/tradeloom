"""Local first-admin helper. Credentials enter only over redirected stdin."""
import json
import os
from pathlib import Path
import sys


def administrator_state():
    from django.contrib.auth import get_user_model
    from enterprise_portal.email_binding import normalize_address
    from enterprise_portal.models import EmailBindingChallenge

    administrators = get_user_model().objects.filter(is_superuser=True)
    has_admin = administrators.exists()
    active = [user for user in administrators.filter(is_active=True) if user.has_usable_password()]
    pending = EmailBindingChallenge.objects.filter(user__in=active).exclude(email="").exists()
    if not has_admin:
        state = "missing"
    elif not active:
        state = "inactive"
    else:
        state = "pending" if pending else "unbound"
        for user in active:
            try:
                normalize_address(user.email)
            except ValueError:
                continue
            state = "ready"
            break
    return {
        "has_admin": has_admin,
        "admin_email_state": state,
        "admin_binding_pending": pending,
    }


def main():
    root = Path(sys.argv[1]).resolve()
    action = sys.argv[2]
    config = json.loads((root / "server-config.json").read_text(encoding="utf-8-sig"))
    secrets = json.loads((root / "secrets/service-secrets.json").read_text(encoding="utf-8-sig"))
    sys.path.insert(0, str(Path(config["runtime_root"]) / "python-packages"))
    sys.path.insert(0, config["app_root"])
    os.environ.update({
        "DJANGO_SETTINGS_MODULE": "config.enterprise_settings",
        "TRADELOOM_ENTERPRISE_SECRET_KEY": secrets["django_secret_key"],
        "TRADELOOM_ENTERPRISE_DATA_ROOT": str(root),
        "TRADELOOM_OPERATIONS_VAULT_DIR": str(root / "operations-vault"),
        "TRADELOOM_ENTERPRISE_ALLOWED_HOSTS": "127.0.0.1,localhost",
        "TRADELOOM_ENTERPRISE_BIND_HOST": "127.0.0.1",
        "TRADELOOM_ENTERPRISE_HTTPS": "0",
        "TRADELOOM_ENTERPRISE_DATABASE_ALLOW_REMOTE": "0",
        "TRADELOOM_DB_NAME": secrets["database_name"],
        "TRADELOOM_DB_USER": secrets["database_user"],
        "TRADELOOM_DB_PASSWORD": secrets["database_password"],
        "TRADELOOM_DB_HOST": "127.0.0.1",
        "TRADELOOM_DB_PORT": str(config["postgres_port"]),
    })

    import django
    django.setup()
    from django.contrib.auth import get_user_model
    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError
    from django.db import connection, transaction
    from enterprise_portal import login_mail
    from enterprise_portal.email_binding import confirm_binding, normalize_address, prepare_initial_binding, start_binding
    from enterprise_portal.models import EmailBindingChallenge

    User = get_user_model()

    def response(ok, message=None, **extra):
        result = {"ok": ok, **administrator_state(), **login_mail.configuration_status(), **extra}
        if message:
            result["message"] = message
        return result

    if action == "status":
        return response(True)
    if action not in {"create", "mail"}:
        return response(False, "不支持的管理员操作。")
    # Read one bounded JSON document and never echo it or raw exceptions.
    try:
        line = sys.stdin.readline(65537)
        if len(line) > 65536:
            raise ValueError("Payload too long.")
        payload = json.loads(line)
    except ValueError:
        return response(False, "管理员操作参数无效。")
    if not isinstance(payload, dict):
        return response(False, "管理员操作参数无效。")

    if action == "mail":
        operation = payload.get("operation")
        username = payload.get("username")
        try:
            if operation in ("smtp", "smtp-replace") and set(payload) == {"operation", "smtp"}:
                try:
                    login_mail.configure(payload["smtp"], replace=(operation == "smtp-replace"))
                except Exception:
                    return response(False, "发信配置未保存，请核对参数或本机密钥存储。")
                return response(True, "发信配置已保存。")
            if operation in ("bind-email", "bind-email-start") and set(payload) == {"operation", "username", "email"}:
                start_binding(username, payload["email"])
            elif operation == "bind-email-resend" and set(payload) == {"operation", "username"}:
                start_binding(username)
            elif operation == "bind-email-verify" and set(payload) == {"operation", "username", "code"}:
                confirm_binding(username, payload["code"])
                return response(True, "邮箱绑定已验证。该账号须重新进行两步登录。",
                                binding_confirmation_required=False)
            else:
                return response(False, "邮件设置参数无效。")
        except ValueError as exc:
            pending = isinstance(username, str) and EmailBindingChallenge.objects.filter(
                user__username=username.strip()
            ).exclude(email="").exists()
            return response(False, str(exc), binding_confirmation_required=bool(pending))
        return response(True, "已发送绑定验证码。验证后新邮箱才会用于登录。",
                        binding_confirmation_required=True)

    error = ""
    with transaction.atomic():
        # Keep the cross-process, cross-package PostgreSQL single-first-admin guard.
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(618, 1401)")
        if User.objects.filter(is_superuser=True).exists():
            error = "已有管理员，拒绝重复创建。请使用原账号完成设置或登录。"
        elif set(payload) != {"username", "email", "password"} or any(
            not isinstance(payload[field], str) for field in ("username", "email", "password")
        ):
            error = "首个管理员参数无效。"
        else:
            username = payload["username"].strip()
            password = payload["password"]
            user = User(username=username, is_staff=True, is_superuser=True, is_active=True)
            try:
                if not username or not 0 < len(password) <= 4096:
                    raise ValidationError("Username or password required.")
                email = normalize_address(payload["email"])
                user.email = email
                user.full_clean(exclude=["password", "last_login", "date_joined"])
                validate_password(password, user)
            except (ValidationError, ValueError):
                error = "账号、邮箱或密码未通过校验。请使用有效邮箱和 Django 密码规则。"
            else:
                user.email = ""
                user.set_password(password)
                user.save()
                prepare_initial_binding(user, email)
    if error:
        return response(False, error)
    return response(True, "首个管理员已创建。完成发信配置后，发送并验证绑定验证码再登录。",
                    binding_confirmation_required=True)

if __name__ == "__main__":
    try:
        result = main()
    except Exception:
        result = {"ok": False, "message": "管理员操作失败。请确认本安装的服务与数据库正常；账号信息未输出。"}
    print(json.dumps(result, ensure_ascii=True))
    sys.exit(0 if result.get("ok") else 1)
