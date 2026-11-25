import uuid

from django.conf import settings
from django.contrib.auth.models import Group
from django.db import models

from workbench.models import IntakeSourceVersion, Task, WorkflowTask


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



class EmailBindingChallenge(models.Model):
    """A pending address and a purpose-specific ownership verification code."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    email = models.EmailField(blank=True)
    token = models.CharField(max_length=64, blank=True)
    code_digest = models.CharField(max_length=64, blank=True)
    credential_version = models.CharField(max_length=64, blank=True)
    expires_at = models.DateTimeField(null=True)
    last_sent_at = models.DateTimeField(null=True)
    window_started_at = models.DateTimeField(null=True)
    sends_in_window = models.PositiveSmallIntegerField(default=0)
    attempts_left = models.PositiveSmallIntegerField(default=0)

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


class PortableCanvas(models.Model):
    """An editable, inert copy of an imported desktop workflow graph."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=100)
    graph = models.JSONField()
    revision = models.PositiveBigIntegerField(default=1)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [models.Index(fields=["owner", "-updated_at", "id"], name="portable_canvas_owner_idx")]


class WorkflowHandoff(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    workflow = models.ForeignKey(WorkflowTask, on_delete=models.CASCADE)
    code_digest = models.CharField(max_length=64)
    source_session_digest = models.CharField(max_length=64)
    expires_at = models.DateTimeField()


class WorkbookImport(models.Model):
    """An account's receipt for bytes it uploaded to the desktop intake store."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    source = models.ForeignKey(IntakeSourceVersion, on_delete=models.PROTECT)
    display_name = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["owner", "source"], name="enterprise_workbook_owner_source_uniq")]
