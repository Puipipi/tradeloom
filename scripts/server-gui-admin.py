"""Local first-admin helper. Credentials enter only over redirected stdin."""
import json
import os
from pathlib import Path
import sys


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
    from django.core.validators import validate_email
    from django.db import connection, transaction
    User = get_user_model()
    if action == "status":
        from enterprise_portal.login_mail import configured
        return {"ok": True, "has_admin": User.objects.filter(is_superuser=True).exists(), "smtp_configured": configured()}
    if action not in {"create", "mail"}:
        return {"ok": False, "message": "不支持的管理员操作。"}
    # Read a single bounded JSON document. Never print the payload or exceptions.
    payload = json.loads(sys.stdin.readline(65537))
    if action == "mail":
        from enterprise_portal.login_security import bind_email
        from enterprise_portal import login_mail
        if payload.get("operation") == "smtp" and set(payload) == {"operation", "smtp"}:
            login_mail.configure(payload["smtp"])
        elif payload.get("operation") == "bind-email" and set(payload) == {"operation", "username", "email"}:
            bind_email(payload["username"], payload["email"])
        else:
            return {"ok": False, "message": "邮件设置参数无效。"}
        return {"ok": True, "has_admin": User.objects.filter(is_superuser=True).exists(), "smtp_configured": login_mail.configured(), "message": "登录安全设置已保存；未创建登录会话或修改账号权限。"}
    username = payload.get("username", "").strip()
    password = payload.get("password", "")
    email = payload.get("email", "").strip().lower()
    if not username or not password or len(password) > 4096:
        return {"ok": False, "message": "请填写账号和密码（密码最多 4096 字符）。"}
    with transaction.atomic():
        # Database-wide guard works across launcher processes and package copies.
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(618, 1401)")
        if User.objects.filter(is_superuser=True).exists():
            return {"ok": False, "message": "已有管理员，拒绝重复创建。请使用原账号登录。"}
        user = User(username=username, email=email, is_staff=True, is_superuser=True, is_active=True)
        try:
            validate_email(email)
            user.full_clean(exclude=["password", "last_login", "date_joined"])
            validate_password(password, user)
        except ValidationError:
            return {"ok": False, "message": "账号、邮箱或密码未通过校验：账号须有效且未使用，邮箱须有效；密码至少 8 位，不能过于常见、全为数字或与账号相似。"}
        user.set_password(password)
        user.save()
    return {"ok": True, "has_admin": True, "message": "首个管理员已创建，请打开管理控制台登录。"}


if __name__ == "__main__":
    try:
        result = main()
    except Exception:
        result = {"ok": False, "message": "管理员操作失败。请确认本安装的服务与数据库正常；账号信息未输出。"}
    print(json.dumps(result, ensure_ascii=True))
    sys.exit(0 if result.get("ok") else 1)
