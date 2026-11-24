from django.contrib.auth.models import Group, Permission
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Create standard enterprise groups and their initial permissions; does not create accounts."

    def handle(self, *args, **options):
        model_permissions = Permission.objects.filter(content_type__app_label="enterprise_portal")
        owners, owners_created = Group.objects.get_or_create(name="企业老板")
        owner_permissions = model_permissions.filter(codename__in=[
            "add_enterpriseentry", "change_enterpriseentry", "delete_enterpriseentry",
            "view_enterpriseentry", "view_all_enterpriseentry", "view_business_data",
        ])
        if owners_created:
            owners.permissions.set(owner_permissions)
        registrars, registrars_created = Group.objects.get_or_create(name="工厂登记员")
        if registrars_created:
            registrars.permissions.set(model_permissions.filter(codename__in=["add_enterpriseentry", "view_enterpriseentry"]))
        operators, operators_created = Group.objects.get_or_create(name="服务运维员")
        if operators_created:
            operators.permissions.set(model_permissions.filter(codename="use_server_operations"))
        self.stdout.write(self.style.SUCCESS("已检查默认业务用户组；既有用户组授权保持不变。"))
