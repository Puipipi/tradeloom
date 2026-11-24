from django.conf import settings
from django.contrib.auth.models import Group
from django.db import models

from workbench.models import Task


class EmailLoginChallenge(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    token = models.CharField(max_length=64, unique=True)
    code_digest = models.CharField(max_length=64, blank=True)
    email = models.EmailField()
    credential_version = models.CharField(max_length=64)
    expires_at = models.DateTimeField()
    last_sent_at = models.DateTimeField()
    window_started_at = models.DateTimeField()
    sends_in_window = models.PositiveSmallIntegerField(default=0)
    attempts_left = models.PositiveSmallIntegerField(default=5)


class WebsiteNotice(models.Model):
    """Singleton notice for the authenticated enterprise home."""
    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    text = models.CharField(max_length=500, blank=True, default="")
    revision = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(null=True, blank=True)


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
            ("use_server_operations", "Can use safe server diagnostics and operations assistant"),
        ]

    def __str__(self) -> str:
        return f"{self.created_by}: {self.body[:50]}"
