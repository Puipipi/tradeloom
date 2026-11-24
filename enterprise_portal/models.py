from django.conf import settings
from django.contrib.auth.models import Group
from django.db import models

from workbench.models import Task


class EnterpriseEntry(models.Model):
    """A staff entry tied to an actual workbench task and optionally shared by factory group."""

    task = models.ForeignKey(Task, null=True, blank=True, on_delete=models.SET_NULL, related_name="enterprise_entries")
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="enterprise_entries")
    factory_group = models.ForeignKey(Group, null=True, blank=True, on_delete=models.SET_NULL, related_name="enterprise_entries")
    body = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        permissions = [
            ("view_all_enterpriseentry", "Can view all enterprise entries"),
            ("view_business_data", "Can view shared business task and product data"),
        ]

    def __str__(self) -> str:
        return f"{self.created_by}: {self.body[:50]}"
