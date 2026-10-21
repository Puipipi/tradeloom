from __future__ import annotations

import uuid

from django.core.exceptions import ValidationError
from django.db import models


def hex_uuid() -> str:
    return uuid.uuid4().hex


class Task(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    title = models.CharField(max_length=200)
    mode = models.CharField(max_length=20)
    status = models.CharField(max_length=40)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        ordering = ["-created_at"]


class Product(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="products",
    )
    position = models.PositiveIntegerField()
    sku = models.CharField(max_length=120)
    name = models.CharField(max_length=200)
    category = models.CharField(max_length=120)
    material = models.CharField(max_length=200)
    size = models.CharField(max_length=120)
    color = models.CharField(max_length=120)
    image_filename = models.CharField(max_length=255)
    image_stored_name = models.CharField(max_length=255, blank=True, default="")
    missing_fields = models.JSONField(default=list)
    created_at = models.DateTimeField()
    updated_at = models.DateTimeField()

    class Meta:
        ordering = ["position"]


class TaskFile(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="files",
    )
    kind = models.CharField(max_length=32)
    original_name = models.CharField(max_length=255)
    stored_name = models.CharField(max_length=255)
    created_at = models.DateTimeField()

    class Meta:
        ordering = ["created_at"]


class AgentRun(models.Model):
    run_id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        Task,
        on_delete=models.CASCADE,
        related_name="agent_runs",
    )
    capability_id = models.CharField(max_length=64)
    status = models.CharField(max_length=32)
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(null=True, blank=True)
    result = models.JSONField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)

    class Meta:
        ordering = ["-started_at"]


class ProductBatch(Task):
    class Meta:
        proxy = True


class WorkflowTask(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    batch = models.ForeignKey(
        Task,
        on_delete=models.PROTECT,
        related_name="workflow_tasks",
    )
    user_goal = models.TextField()
    task_type = models.CharField(max_length=64)
    creation_idempotency_key = models.CharField(
        max_length=200,
        null=True,
        blank=True,
        unique=True,
    )
    creation_request_fingerprint = models.CharField(
        max_length=64,
        null=True,
        blank=True,
    )
    creation_receipt = models.JSONField(null=True, blank=True)
    status = models.CharField(max_length=32, default="queued")
    current_step = models.CharField(max_length=120, blank=True, default="")
    result_refs = models.JSONField(default=dict)
    error_summary = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]


class ProductRevisionQuerySet(models.QuerySet):
    def update(self, **kwargs):
        blocked = self.model.immutable_fields.intersection(kwargs)
        if blocked:
            raise ValidationError(
                "ProductRevision 的 snapshot/product/version 不可改写。"
            )
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, batch_size=None):
        blocked = self.model.immutable_fields.intersection(fields)
        if blocked:
            raise ValidationError(
                "ProductRevision 的 snapshot/product/version 不可改写。"
            )
        return super().bulk_update(objs, fields, batch_size=batch_size)


class ProductRevision(models.Model):
    immutable_fields = frozenset({"snapshot", "product", "product_id", "version"})

    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    product = models.ForeignKey(
        Product,
        on_delete=models.PROTECT,
        related_name="revisions",
    )
    version = models.PositiveIntegerField()
    snapshot = models.JSONField(default=dict)
    field_sources = models.JSONField(default=dict)
    status = models.CharField(max_length=32, default="draft")
    source_refs = models.JSONField(default=dict)
    reviewer = models.CharField(max_length=120, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ProductRevisionQuerySet.as_manager()

    class Meta:
        ordering = ["product", "version"]
        constraints = [
            models.UniqueConstraint(
                fields=["product", "version"],
                name="uniq_productrev_prod_ver",
            )
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            stored = (
                type(self)
                .objects.filter(pk=self.pk)
                .values("snapshot", "product_id", "version")
                .first()
            )
            if stored is not None and (
                stored["snapshot"] != self.snapshot
                or stored["product_id"] != self.product_id
                or stored["version"] != self.version
            ):
                raise ValidationError(
                    "ProductRevision 的 snapshot/product/version 不可改写。"
                )
        return super().save(*args, **kwargs)


class SubTask(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        WorkflowTask,
        on_delete=models.PROTECT,
        related_name="subtasks",
    )
    agent_role = models.CharField(max_length=64)
    input_refs = models.JSONField(default=dict)
    output_refs = models.JSONField(default=dict)
    status = models.CharField(max_length=32, default="queued")
    depends_on = models.ManyToManyField(
        "self",
        symmetrical=False,
        related_name="dependents",
        blank=True,
    )
    retry_count = models.PositiveIntegerField(default=0)
    error_summary = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]


class WorkflowStep(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        WorkflowTask,
        on_delete=models.PROTECT,
        related_name="steps",
    )
    step_key = models.CharField(max_length=120)
    status = models.CharField(max_length=32, default="queued")
    attempt = models.PositiveIntegerField(default=1)
    idempotency_key = models.CharField(max_length=200, blank=True, default="")
    input_refs = models.JSONField(default=dict)
    output_refs = models.JSONField(default=dict)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    error_summary = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["task", "idempotency_key"],
                condition=~models.Q(idempotency_key=""),
                name="uniq_wfstep_task_idem",
            )
        ]


class HumanReview(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        WorkflowTask,
        on_delete=models.PROTECT,
        related_name="human_reviews",
    )
    item_ref = models.CharField(max_length=200)
    question = models.TextField()
    options = models.JSONField(default=list)
    source_conflict = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=32, default="pending")
    answer = models.JSONField(default=dict, blank=True)
    reviewer = models.CharField(max_length=120, blank=True, default="")
    review_key = models.CharField(max_length=200, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["task", "review_key"],
                condition=models.Q(status="pending") & ~models.Q(review_key=""),
                name="uniq_review_task_key_pending",
            )
        ]


class Artifact(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        WorkflowTask,
        on_delete=models.PROTECT,
        related_name="artifacts",
    )
    artifact_type = models.CharField(max_length=64)
    storage_key = models.CharField(max_length=255)
    current_version = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=32, default="draft")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]


class ArtifactVersion(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    artifact = models.ForeignKey(
        Artifact,
        on_delete=models.PROTECT,
        related_name="versions",
    )
    version = models.PositiveIntegerField()
    file_path = models.CharField(max_length=500)
    sha256 = models.CharField(max_length=64)
    source_product_versions = models.JSONField(default=list)
    snapshot = models.JSONField(default=dict)
    status = models.CharField(max_length=32, default="draft")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["artifact", "version"]
        constraints = [
            models.UniqueConstraint(
                fields=["artifact", "version"],
                name="uniq_artifactversion_art_ver",
            )
        ]


class EventLog(models.Model):
    id = models.CharField(
        primary_key=True,
        max_length=32,
        default=hex_uuid,
        editable=False,
    )
    task = models.ForeignKey(
        WorkflowTask,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="events",
    )
    subtask = models.ForeignKey(
        SubTask,
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name="events",
    )
    event_type = models.CharField(max_length=64)
    actor = models.CharField(max_length=120)
    payload_summary = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
