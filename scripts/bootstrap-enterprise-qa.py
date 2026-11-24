"""Create disposable local QA accounts and a linked business fixture; never for deployment."""
from __future__ import annotations

import json
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.enterprise_settings")

import django

django.setup()

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.management import call_command
from django.utils import timezone

from enterprise_portal.models import EnterpriseEntry
from workbench.models import Product, Task


OUT = ROOT / "testing" / "enterprise-accounts.json"
OUT.parent.mkdir(parents=True, exist_ok=True)
call_command("configure_enterprise_groups", verbosity=0)
roles = {
    "admin": None,
    "owner": "企业老板",
    "registrar": "工厂登记员",
    "registrar2": "工厂登记员",
}
User = get_user_model()
accounts = {}
for key, group_name in roles.items():
    username = f"qa-{key}"
    password = secrets.token_urlsafe(24)
    user, _ = User.objects.get_or_create(username=username)
    user.set_password(password)
    user.is_active = True
    user.is_staff = key in {"admin", "owner"}
    user.is_superuser = key == "admin"
    user.save()
    user.groups.set([Group.objects.get(name=group_name)] if group_name else [])
    accounts[key] = {"username": username, "password": password}

task = Task.objects.filter(title="企业服务 QA 合成业务批次").first()
if task is None:
    task = Task.objects.create(
        title="企业服务 QA 合成业务批次", mode="qa", status="qa_fixture",
        created_at=timezone.now(), updated_at=timezone.now(),
    )
Product.objects.get_or_create(
    task=task, sku="QA-ENTERPRISE-001",
    defaults={
        "position": 1, "name": "企业服务 QA 合成产品", "category": "QA",
        "material": "合成数据", "size": "—", "color": "—",
        "image_filename": "", "image_stored_name": "", "missing_fields": [],
        "created_at": timezone.now(), "updated_at": timezone.now(),
    },
)
EnterpriseEntry.objects.filter(body__startswith="qa-fixture:").delete()
EnterpriseEntry.objects.create(task=task, created_by=User.objects.get(username="qa-registrar"), body="qa-fixture:registrar-private")
OUT.write_text(json.dumps({"accounts": accounts, "task_id": task.pk}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Created isolated QA accounts and linked fixture: {OUT}")
