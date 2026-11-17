from __future__ import annotations

import uuid

from django.core.exceptions import ValidationError
from django.db import models, router, transaction
from django.db.models import Q


def hex_uuid() -> str:
    return uuid.uuid4().hex


class CanvasWorkflowRun(models.Model):
    """Durable visual-workflow receipt; distinct from confirmed business tasks."""

    id = models.UUIDField(primary_key=True, editable=False)
    workflow_id = models.CharField(max_length=48, db_index=True)
    revision = models.PositiveIntegerField(default=1)
    status = models.CharField(max_length=20)
    execution_mode = models.CharField(max_length=20)
    snapshot = models.JSONField()
    owner_namespace_id = models.UUIDField(null=True, blank=True)
    owner_id = models.UUIDField(null=True, blank=True)
    owner_epoch = models.BigIntegerField(null=True, blank=True)
    owner_token_hash = models.CharField(max_length=64, null=True, blank=True)
    owner_create_fingerprint = models.CharField(max_length=64, null=True, blank=True)
    owner_lease_expires_at = models.DateTimeField(null=True, blank=True)
    owner_released_at = models.DateTimeField(null=True, blank=True)
    owner_fenced_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["workflow_id"],
                condition=models.Q(status__in=["running", "waiting"]),
                name="canvas_one_active_workflow_run",
            )
        ]


class CanvasWorkflowRunNamespace(models.Model):
    """Server-created identity for the database that owns workflow runs."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    namespace_id = models.UUIDField(unique=True, editable=False)

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(id=1), name="canvas_workflow_run_namespace_singleton")]

    def save(self, *args, **kwargs):
        if self.pk != 1:
            raise ValidationError("Canvas workflow run namespace is a singleton")
        if not self._state.adding:
            current = type(self).objects.using(kwargs.get("using") or self._state.db).filter(pk=1).values_list(
                "namespace_id", flat=True
            ).first()
            if current is not None and current != self.namespace_id:
                raise ValidationError("Canvas workflow run namespace is immutable")
        return super().save(*args, **kwargs)


class CanvasWorkflowDefinition(models.Model):
    """Latest durable Canvas definition, independent of historical run snapshots."""

    workflow_id = models.CharField(max_length=48, primary_key=True)
    revision = models.PositiveBigIntegerField(default=1)
    definition_revision = models.CharField(max_length=71, null=True, blank=True)
    # Text JSON preserves legal JSON strings containing U+0000, which PostgreSQL jsonb rejects.
    document = models.TextField(null=True, blank=True)
    deleted = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["workflow_id"]
        constraints = [
            models.CheckConstraint(condition=models.Q(revision__gt=0), name="canvas_workflow_definition_revision_positive"),
        ]


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


class AppendOnlyQuerySet(models.QuerySet):
    use_in_migrations = True

    def update(self, **kwargs):
        raise ValidationError("导入来源证据为追加记录，不可批量改写。")

    def bulk_update(self, objs, fields, batch_size=None):
        raise ValidationError("导入来源证据为追加记录，不可批量改写。")

    def delete(self):
        raise ValidationError("导入来源证据不可删除。")


class AppendOnlyModel(models.Model):
    objects = AppendOnlyQuerySet.as_manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("导入来源证据为追加记录，不可改写。")
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("导入来源证据不可删除。")


class IntakeSourceVersion(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    sha256 = models.CharField(max_length=64, unique=True)
    storage_key = models.CharField(max_length=80, unique=True)
    original_name = models.CharField(max_length=255)
    byte_size = models.PositiveBigIntegerField()
    mime_type = models.CharField(max_length=120)
    received_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-received_at"]


class WorkbookSnapshot(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    source = models.ForeignKey(IntakeSourceVersion, on_delete=models.PROTECT, related_name="snapshots")
    parser_version = models.CharField(max_length=40)
    status = models.CharField(max_length=20)
    error_code = models.CharField(max_length=64, blank=True, default="")
    warnings = models.JSONField(default=list)
    sheet_count = models.PositiveIntegerField(default=0)
    cell_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["source", "parser_version"], name="uniq_intake_source_parser")]


class WorkbookSheetSnapshot(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    snapshot = models.ForeignKey(WorkbookSnapshot, on_delete=models.PROTECT, related_name="sheets")
    sheet_index = models.PositiveSmallIntegerField()
    title = models.CharField(max_length=255)
    dimensions = models.CharField(max_length=64, blank=True, default="")
    merged_ranges = models.JSONField(default=list)
    source_part = models.CharField(max_length=255)
    warnings = models.JSONField(default=list)

    class Meta:
        ordering = ["sheet_index"]
        constraints = [models.UniqueConstraint(fields=["snapshot", "sheet_index"], name="uniq_intake_snapshot_sheet")]


class SourceCellSnapshot(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    sheet = models.ForeignKey(WorkbookSheetSnapshot, on_delete=models.PROTECT, related_name="cells")
    coordinate = models.CharField(max_length=16)
    source_type = models.CharField(max_length=24, blank=True, default="")
    raw_value = models.JSONField(null=True, blank=True)
    normalized_value = models.JSONField(null=True, blank=True)
    formula = models.TextField(blank=True, default="")
    cached_value = models.JSONField(null=True, blank=True)
    number_format = models.CharField(max_length=120, blank=True, default="")
    formula_status = models.CharField(max_length=24, blank=True, default="")
    error_code = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["coordinate"]
        constraints = [models.UniqueConstraint(fields=["sheet", "coordinate"], name="uniq_intake_sheet_cell")]


class WorkbookImageReference(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    snapshot = models.ForeignKey(WorkbookSnapshot, on_delete=models.PROTECT, related_name="image_references")
    sheet = models.ForeignKey(WorkbookSheetSnapshot, null=True, blank=True, on_delete=models.PROTECT, related_name="image_references")
    kind = models.CharField(max_length=24)
    coordinate = models.CharField(max_length=16, blank=True, default="")
    anchor = models.JSONField(null=True, blank=True)
    source_part = models.CharField(max_length=255)
    relationship_id = models.CharField(max_length=120, blank=True, default="")
    target_part = models.CharField(max_length=255, blank=True, default="")
    mime_type = models.CharField(max_length=120, blank=True, default="")
    rich_value_index = models.PositiveIntegerField(null=True, blank=True)
    relationship_slot = models.PositiveIntegerField(null=True, blank=True)
    warning_code = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["sheet_id", "coordinate", "source_part"]

    def _validate_snapshot_relation(self):
        if self.sheet_id and self.snapshot_id and self.sheet.snapshot_id != self.snapshot_id:
            raise ValidationError("图片来源与工作簿快照不匹配。")

    def save(self, *args, **kwargs):
        self._validate_snapshot_relation()
        return super().save(*args, **kwargs)


class IntakeOperationReceipt(models.Model):
    """Small local idempotency receipt for intake API mutations."""

    class State(models.TextChoices):
        RESERVED = "reserved", "Reserved"
        SUCCEEDED = "succeeded", "Succeeded"
        FAILED = "failed", "Failed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    idempotency_key = models.CharField(max_length=200, unique=True)
    action = models.CharField(max_length=32)
    fingerprint = models.CharField(max_length=64)
    state = models.CharField(max_length=16, choices=State.choices, default=State.RESERVED)
    result_type = models.CharField(max_length=32, blank=True, default="")
    result_id = models.CharField(max_length=32, blank=True, default="")
    error_code = models.CharField(max_length=64, blank=True, default="")
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]


class BusinessDispatch(models.Model):
    """Auditable notification/action sent from one native agent session to another."""

    class Kind(models.TextChoices):
        NOTIFICATION = "notification", "Notification"
        ACTION = "action", "Action"

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        CLAIMED = "claimed", "Claimed"
        ACKNOWLEDGED = "acknowledged", "Acknowledged"
        COMPLETED = "completed", "Completed"
        FAILED = "failed", "Failed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    sender_session_id = models.CharField(max_length=256, db_index=True)
    sender_agent_id = models.CharField(max_length=256)
    sender_preset = models.CharField(max_length=80)
    recipient_session_id = models.CharField(max_length=256, db_index=True)
    recipient_agent_id = models.CharField(max_length=256)
    recipient_preset = models.CharField(max_length=80)
    source = models.CharField(max_length=200)
    requirement = models.TextField(max_length=4000)
    idempotency_key = models.CharField(max_length=200)
    request_fingerprint = models.CharField(max_length=64)
    delivery_result = models.JSONField(default=dict)
    receipt = models.JSONField(null=True, blank=True)
    receipt_fingerprint = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    claimed_at = models.DateTimeField(null=True, blank=True)
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [
            models.UniqueConstraint(
                fields=["sender_session_id", "idempotency_key"],
                name="uniq_dispatch_sender_idem",
            ),
            models.UniqueConstraint(
                fields=["recipient_session_id"],
                condition=models.Q(kind="action", status="claimed"),
                name="uniq_dispatch_action_claim_recipient",
            ),
        ]

class IntakeMappingRevision(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    snapshot = models.ForeignKey(WorkbookSnapshot, on_delete=models.PROTECT, related_name="mapping_revisions")
    source_sha256 = models.CharField(max_length=64)
    candidate_type = models.CharField(max_length=32)
    schema_version = models.PositiveSmallIntegerField()
    revision = models.PositiveIntegerField()
    mapping = models.JSONField(default=dict)
    mapping_sha256 = models.CharField(max_length=64)
    idempotency_key = models.CharField(max_length=200, unique=True)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["snapshot_id", "candidate_type", "revision"]
        constraints = [
            models.UniqueConstraint(fields=["snapshot", "candidate_type", "revision"], name="uniq_intake_mapping_revision"),
        ]


class IntakeCandidate(AppendOnlyModel):
    class Status(models.TextChoices):
        UNCONFIRMED = "unconfirmed", "Unconfirmed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    mapping_revision = models.ForeignKey(IntakeMappingRevision, on_delete=models.PROTECT, related_name="candidates")
    source_sha256 = models.CharField(max_length=64)
    candidate_type = models.CharField(max_length=32)
    schema_version = models.PositiveSmallIntegerField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.UNCONFIRMED)
    typed_payload = models.JSONField(default=dict)
    provenance = models.JSONField(default=dict)
    idempotency_key = models.CharField(max_length=200, unique=True)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [models.UniqueConstraint(fields=["mapping_revision"], name="uniq_intake_candidate_mapping")]


class IntakeCandidateLink(AppendOnlyModel):
    class Decision(models.TextChoices):
        SUGGESTED = "suggested", "Suggested"
        CONFIRMED = "confirmed", "Confirmed"
        REJECTED = "rejected", "Rejected"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    left_candidate = models.ForeignKey(IntakeCandidate, on_delete=models.PROTECT, related_name="outgoing_links")
    right_candidate = models.ForeignKey(IntakeCandidate, on_delete=models.PROTECT, related_name="incoming_links")
    decision = models.CharField(max_length=16, choices=Decision.choices)
    evidence = models.JSONField(default=dict)
    idempotency_key = models.CharField(max_length=200, unique=True)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]


class ProductionRequirementDraft(models.Model):
    class RecordKind(models.TextChoices):
        NEW_DEMAND = "new_demand", "New demand"
        HISTORICAL_REFERENCE = "historical_reference", "Historical reference"

    class Status(models.TextChoices):
        NEEDS_CONFIRMATION = "needs_confirmation", "Needs confirmation"
        CONFIRMED = "confirmed", "Confirmed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    source_candidate = models.ForeignKey(IntakeCandidate, on_delete=models.PROTECT, related_name="requirement_drafts")
    record_kind = models.CharField(max_length=32, choices=RecordKind.choices)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.NEEDS_CONFIRMATION)
    current_revision = models.PositiveIntegerField(default=1)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "-id"]
        constraints = [models.UniqueConstraint(fields=["source_candidate"], name="uniq_req_draft_candidate")]


class ProductionRequirementRevision(AppendOnlyModel):
    class Status(models.TextChoices):
        NEEDS_CONFIRMATION = "needs_confirmation", "Needs confirmation"
        CONFIRMED = "confirmed", "Confirmed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    draft = models.ForeignKey(ProductionRequirementDraft, on_delete=models.PROTECT, related_name="revisions")
    revision = models.PositiveIntegerField()
    fields = models.JSONField(default=dict)
    unresolved_fields = models.JSONField(default=dict)
    confirmed_unit_pair = models.JSONField(null=True, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.NEEDS_CONFIRMATION)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["draft_id", "revision"]
        constraints = [models.UniqueConstraint(fields=["draft", "revision"], name="uniq_req_revision_number")]


class ProductionRequirementLine(models.Model):
    """生产要求的明细行（物料×数量×单位），来自 production_instruction_line 打表候选。

    行由候选 apply 生成并随主数据补齐重新 apply 刷新；阻断问题未清时
    阻止生产要求确认（对应 PMC 核料闸门）。
    """

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    draft = models.ForeignKey(ProductionRequirementDraft, on_delete=models.PROTECT, related_name="material_lines")
    source_candidate = models.ForeignKey(IntakeCandidate, on_delete=models.PROTECT, related_name="requirement_lines")
    position = models.PositiveIntegerField()
    material = models.CharField(max_length=500)
    item_ref = models.JSONField(null=True, blank=True)
    item_status = models.CharField(max_length=24, default="unresolved")
    quantity = models.CharField(max_length=40, blank=True, default="")
    unit = models.CharField(max_length=64, blank=True, default="")
    issues = models.JSONField(default=list)
    source_refs = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["draft_id", "position", "id"]
        constraints = [
            models.UniqueConstraint(fields=["source_candidate", "position"], name="uniq_req_line_candidate_position"),
            models.CheckConstraint(condition=models.Q(material__gt=""), name="req_line_material_present"),
        ]


class ExecutionPlanRevision(AppendOnlyModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    requirement_revision = models.ForeignKey(
        ProductionRequirementRevision, on_delete=models.PROTECT, related_name="execution_plan_revisions"
    )
    revision = models.PositiveIntegerField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT)
    requirement_refs = models.JSONField(default=list)
    materials = models.JSONField(default=list)
    operations = models.JSONField(default=list)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["requirement_revision_id", "revision"]
        constraints = [
            models.UniqueConstraint(fields=["requirement_revision", "revision"], name="uniq_execution_plan_revision"),
            models.CheckConstraint(condition=models.Q(revision__gt=0), name="execution_plan_revision_positive"),
            models.CheckConstraint(condition=models.Q(status="draft"), name="execution_plan_draft_only"),
        ]


class NarrativeSourceVersion(AppendOnlyModel):
    """Immutable UTF-8 note source stored under the private intake root."""

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    sha256 = models.CharField(max_length=64, unique=True)
    storage_key = models.CharField(max_length=120, unique=True)
    display_name = models.CharField(max_length=255)
    byte_size = models.PositiveBigIntegerField()
    line_count = models.PositiveIntegerField()
    mime_type = models.CharField(max_length=64, default="text/plain; charset=utf-8")
    received_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-received_at", "-id"]


class NarrativeAnnotationRevision(AppendOnlyModel):
    """Immutable, explicitly attributed context about a narrative source."""

    class SourceKind(models.TextChoices):
        TRANSCRIPT_EXCERPT = "transcript_excerpt", "Transcript excerpt"
        SECONDARY_SUMMARY_ANALYSIS = "secondary_summary_analysis", "Secondary summary or analysis"
        USER_SUPPLEMENT = "user_supplement", "User supplement"
        UNKNOWN = "unknown", "Unknown"

    class AudioReviewStatus(models.TextChoices):
        UNKNOWN = "unknown", "Unknown"
        NOT_CHECKED = "not_checked", "Not checked"
        OPERATOR_CLAIMED_CHECKED = "operator_claimed_checked", "Operator claimed checked"

    class ContentStatus(models.TextChoices):
        UNCONFIRMED = "unconfirmed", "Unconfirmed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    source = models.ForeignKey(
        NarrativeSourceVersion, on_delete=models.PROTECT, related_name="annotation_revisions"
    )
    revision = models.PositiveIntegerField()
    source_kind = models.CharField(max_length=40, choices=SourceKind.choices)
    recording_date = models.DateField(null=True, blank=True)
    audio_review_status = models.CharField(max_length=32, choices=AudioReviewStatus.choices)
    content_status = models.CharField(max_length=16, choices=ContentStatus.choices, default=ContentStatus.UNCONFIRMED)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["source_id", "revision"]
        constraints = [
            models.UniqueConstraint(fields=["source", "revision"], name="uniq_narrative_annotation_revision"),
            models.CheckConstraint(condition=Q(revision__gt=0), name="narrative_annotation_revision_positive"),
            models.CheckConstraint(condition=Q(content_status="unconfirmed"), name="narrative_annotation_unconfirmed"),
        ]


class EvidenceRecord(AppendOnlyModel):
    class Kind(models.TextChoices):
        SOURCE_RECORD = "source_record", "Source record"
        OPERATOR_STATEMENT = "operator_statement", "Operator statement"
        TEAM_HYPOTHESIS = "team_hypothesis", "Team hypothesis"
        SYSTEM_DERIVATION = "system_derivation", "System derivation"

    class Status(models.TextChoices):
        UNVERIFIED = "unverified", "Unverified"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    candidate = models.ForeignKey(IntakeCandidate, null=True, blank=True, on_delete=models.PROTECT, related_name="evidence_records")
    requirement_revision = models.ForeignKey(
        ProductionRequirementRevision, null=True, blank=True, on_delete=models.PROTECT, related_name="evidence_records"
    )
    field_key = models.CharField(max_length=64)
    kind = models.CharField(max_length=32, choices=Kind.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.UNVERIFIED)
    summary = models.CharField(max_length=1_000, blank=True, default="")
    revision = models.PositiveIntegerField()
    input_record_ids = models.JSONField(default=list)
    source_snapshot = models.ForeignKey(
        WorkbookSnapshot, null=True, blank=True, on_delete=models.PROTECT, related_name="evidence_records"
    )
    source_sheet = models.ForeignKey(
        WorkbookSheetSnapshot, null=True, blank=True, on_delete=models.PROTECT, related_name="evidence_records"
    )
    coordinate = models.CharField(max_length=16, blank=True, default="")
    narrative_source = models.ForeignKey(
        NarrativeSourceVersion, null=True, blank=True, on_delete=models.PROTECT, related_name="evidence_records"
    )
    line_start = models.PositiveIntegerField(null=True, blank=True)
    line_end = models.PositiveIntegerField(null=True, blank=True)
    rule_id = models.CharField(max_length=64, blank=True, default="")
    rule_version = models.CharField(max_length=64, blank=True, default="")
    idempotency_key = models.CharField(max_length=200, unique=True)
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["candidate", "created_at"], name="intake_evidence_candidate_idx")]
        constraints = [
            models.CheckConstraint(
                condition=(Q(candidate__isnull=False, requirement_revision__isnull=True) |
                           Q(candidate__isnull=True, requirement_revision__isnull=False)),
                name="intake_evidence_one_target",
            ),
            models.UniqueConstraint(
                fields=["candidate", "field_key", "kind", "revision"],
                condition=Q(candidate__isnull=False), name="uniq_intake_evidence_candidate_revision",
            ),
            models.UniqueConstraint(
                fields=["requirement_revision", "field_key", "kind", "revision"],
                condition=Q(requirement_revision__isnull=False), name="uniq_req_evidence_revision",
            ),
        ]

    def save(self, *args, **kwargs):
        if bool(self.candidate_id) == bool(self.requirement_revision_id):
            raise ValidationError("证据必须且只能绑定一个目标。")
        if self.source_sheet_id and self.source_snapshot_id:
            if self.source_sheet.snapshot_id != self.source_snapshot_id:
                raise ValidationError("证据定位与工作簿快照不匹配。")
        if self.requirement_revision_id and self.source_snapshot_id:
            revision = self.requirement_revision
            candidate = revision.draft.source_candidate
            if self.source_snapshot_id != candidate.mapping_revision.snapshot_id:
                raise ValidationError("证据来源与生产要求的候选来源不匹配。")
            if (self.source_sheet_id and
                    self.source_sheet.snapshot_id != candidate.mapping_revision.snapshot_id):
                raise ValidationError("证据来源与生产要求的候选来源不匹配。")
        return super().save(*args, **kwargs)


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


class ErpNextDraftOperationQuerySet(models.QuerySet):
    immutable_fields = frozenset({
        "instance_id", "idempotency_key", "action", "fingerprint",
        "payload_sha256", "request_payload", "expected_modified",
        "workflow", "workflow_id", "target_operation", "target_operation_id",
        "doctype", "source",
    })
    protected_transition_fields = frozenset({"status", "receipt", "remote_name", "remote_modified", "result_ref"})

    def update(self, **kwargs):
        if self.immutable_fields.intersection(kwargs):
            raise ValidationError("ERPNext 操作请求身份不可改写。")
        if self.protected_transition_fields.intersection(kwargs):
            raise ValidationError("ERPNext 操作状态与远端结果只能由操作服务迁移。")
        return super().update(**kwargs)

    def delete(self):
        raise ValidationError("ERPNext 草稿操作记录不可删除。")


class ErpNextDraftOperation(models.Model):
    class Action(models.TextChoices):
        CREATE = "create", "创建草稿"
        UPDATE = "update", "修改草稿"

    class Status(models.TextChoices):
        RESERVED = "reserved", "操作已预留"
        SUCCEEDED = "succeeded", "已回读确认"
        OUTCOME_UNKNOWN = "outcome_unknown", "结果待调和"
        CONFLICT = "conflict", "远端版本冲突"

    class Source(models.TextChoices):
        LOCAL_WORKBENCH = "local_workbench", "本地工作台"
        DSH_CENTER = "dsh_center", "中心 Agent"

    id = models.CharField(
        primary_key=True, max_length=32, default=hex_uuid, editable=False,
    )
    instance_id = models.CharField(max_length=128)
    idempotency_key = models.CharField(max_length=200)
    action = models.CharField(max_length=16, choices=Action.choices)
    fingerprint = models.CharField(max_length=64)
    payload_sha256 = models.CharField(max_length=64)
    request_payload = models.JSONField()
    expected_modified = models.CharField(max_length=64, blank=True, default="")
    workflow = models.ForeignKey(
        WorkflowTask, null=True, blank=True, on_delete=models.PROTECT,
        related_name="erpnext_draft_operations",
    )
    target_operation = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT,
        related_name="updates",
    )
    doctype = models.CharField(max_length=32, default="Quotation")
    source = models.CharField(max_length=32, choices=Source.choices)
    status = models.CharField(
        max_length=24, choices=Status.choices, default=Status.OUTCOME_UNKNOWN,
    )
    remote_name = models.CharField(max_length=255, blank=True, default="")
    remote_modified = models.CharField(max_length=64, blank=True, default="")
    receipt = models.JSONField(null=True, blank=True)
    result_ref = models.JSONField(default=dict)
    error_code = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ErpNextDraftOperationQuerySet.as_manager()

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["instance_id", "idempotency_key"],
                name="uniq_erp_draft_instance_key",
            ),
            models.CheckConstraint(
                condition=models.Q(doctype="Quotation"),
                name="erp_draft_fixed_quotation",
            ),
        ]

    def save(self, *args, **kwargs):
        using = kwargs.get("using") or router.db_for_write(type(self), instance=self)
        with transaction.atomic(using=using):
            if not self._state.adding:
                stored = type(self).objects.using(using).select_for_update().filter(pk=self.pk).values(
                    "instance_id", "idempotency_key", "action", "fingerprint",
                    "payload_sha256", "request_payload", "expected_modified",
                    "workflow_id", "target_operation_id", "doctype", "source",
                    "status", "receipt", "remote_name", "remote_modified", "result_ref",
                    "error_code", "updated_at",
                ).first()
                if stored is not None:
                    allowed_transitions = {
                        self.Status.RESERVED: {
                            self.Status.RESERVED, self.Status.SUCCEEDED, self.Status.OUTCOME_UNKNOWN,
                            self.Status.CONFLICT,
                        },
                        self.Status.OUTCOME_UNKNOWN: {
                            self.Status.OUTCOME_UNKNOWN, self.Status.SUCCEEDED, self.Status.CONFLICT,
                        },
                        self.Status.SUCCEEDED: {self.Status.SUCCEEDED},
                        self.Status.CONFLICT: {self.Status.CONFLICT},
                    }
                    if self.status not in allowed_transitions.get(stored["status"], set()):
                        if stored["status"] in {self.Status.SUCCEEDED, self.Status.CONFLICT}:
                            for field, value in stored.items():
                                setattr(self, field, value)
                            return
                        raise ValidationError("ERPNext 操作状态迁移无效。")
                    immutable_values = {
                        "instance_id": self.instance_id,
                        "idempotency_key": self.idempotency_key,
                        "action": self.action,
                        "fingerprint": self.fingerprint,
                        "payload_sha256": self.payload_sha256,
                        "request_payload": self.request_payload,
                        "expected_modified": self.expected_modified,
                        "workflow_id": self.workflow_id,
                        "target_operation_id": self.target_operation_id,
                        "doctype": self.doctype,
                        "source": self.source,
                    }
                    if any(stored[field] != value for field, value in immutable_values.items()):
                        raise ValidationError("ERPNext 操作请求身份不可改写。")
                    if stored["receipt"] is not None and stored["receipt"] != self.receipt:
                        raise ValidationError("ERPNext 操作收据不可改写。")
                    if stored["status"] == self.Status.SUCCEEDED and any(
                        stored[field] != value for field, value in {
                            "remote_name": self.remote_name,
                            "remote_modified": self.remote_modified,
                            "result_ref": self.result_ref,
                        }.items()
                    ):
                        raise ValidationError("已成功的 ERPNext 操作结果不可改写。")
            return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("ERPNext 草稿操作记录不可删除。")

class NativeArtifactVersion(models.Model):
    """Immutable registered bytes with frozen native terminal provenance."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    run = models.ForeignKey(CanvasWorkflowRun, on_delete=models.PROTECT, related_name="native_artifacts")
    node_id = models.CharField(max_length=128)
    attempt = models.PositiveIntegerField()
    child_session_id = models.CharField(max_length=256)
    native_run_id = models.CharField(max_length=256)
    request_id = models.CharField(max_length=256)
    tool_call_id = models.CharField(max_length=256)
    parent_agent_id = models.CharField(max_length=256)
    parent_session_id = models.CharField(max_length=256)
    binding_revision = models.CharField(max_length=128)
    definition_revision = models.CharField(max_length=128)
    source_session_seq = models.PositiveBigIntegerField()
    file_index = models.PositiveIntegerField()
    present_call_id = models.CharField(max_length=256)
    source_turn = models.PositiveBigIntegerField()
    grant_root_scope = models.CharField(max_length=256)
    display_name = models.CharField(max_length=255)
    mime_type = models.CharField(max_length=128)
    byte_size = models.PositiveBigIntegerField()
    sha256 = models.CharField(max_length=64)
    storage_key = models.CharField(max_length=500, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['run', 'node_id', 'attempt', 'source_session_seq', 'file_index'], name='uniq_native_artifact_coordinate')]

class Customer(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    display_name = models.CharField(max_length=200)
    merged_into = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="merged_sources"
    )
    merged_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["display_name", "id"]
        constraints = [
            models.CheckConstraint(
                condition=~Q(merged_into=models.F("id")), name="customer_no_self_merge"
            ),
        ]


class CustomerAlias(models.Model):
    class Decision(models.TextChoices):
        SUGGESTED = "suggested", "Suggested"
        CONFIRMED = "confirmed", "Confirmed"
        REJECTED = "rejected", "Rejected"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    customer = models.ForeignKey(
        Customer, null=True, blank=True, on_delete=models.PROTECT, related_name="aliases"
    )
    source_candidate = models.ForeignKey(
        IntakeCandidate, null=True, blank=True, on_delete=models.PROTECT, related_name="customer_aliases"
    )
    raw_text = models.CharField(max_length=200)
    normalized_text = models.CharField(max_length=200, unique=True)
    decision = models.CharField(max_length=16, choices=Decision.choices, default=Decision.SUGGESTED)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(decision="confirmed", customer__isnull=False)
                    | Q(decision__in=["suggested", "rejected"], customer__isnull=True)
                ),
                name="customer_alias_identity_consistent",
            ),
        ]


class CustomerAliasDecision(AppendOnlyModel):
    class Kind(models.TextChoices):
        CONFIRMED = "confirmed", "Confirmed"
        REJECTED = "rejected", "Rejected"
        REASSIGNED = "reassigned", "Reassigned"
        MERGED = "merged", "Merged"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    alias = models.ForeignKey(CustomerAlias, on_delete=models.PROTECT, related_name="decision_history")
    from_customer = models.ForeignKey(
        Customer, null=True, blank=True, on_delete=models.PROTECT, related_name="alias_decisions_from"
    )
    to_customer = models.ForeignKey(
        Customer, null=True, blank=True, on_delete=models.PROTECT, related_name="alias_decisions_to"
    )
    decision = models.CharField(max_length=16, choices=Kind.choices)
    note = models.TextField(blank=True, default="")
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]


class CustomerMerge(AppendOnlyModel):
    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    source_customer = models.ForeignKey(
        Customer, on_delete=models.PROTECT, related_name="merge_outgoing"
    )
    target_customer = models.ForeignKey(
        Customer, on_delete=models.PROTECT, related_name="merge_incoming"
    )
    note = models.TextField(blank=True, default="")
    actor = models.CharField(max_length=32, default="local_workbench")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(fields=["source_customer"], name="uniq_customer_merge_source"),
            models.CheckConstraint(
                condition=~Q(source_customer=models.F("target_customer")),
                name="customer_merge_distinct_customers",
            ),
        ]


class CustomerEvent(AppendOnlyModel):
    class Kind(models.TextChoices):
        INQUIRY = "inquiry", "Inquiry"
        QUOTATION = "quotation", "Quotation"
        ORDER = "order", "Order"
        ISSUE = "issue", "Issue"
        REPLY = "reply", "Reply"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="events")
    alias = models.ForeignKey(CustomerAlias, on_delete=models.PROTECT, related_name="events")
    source_candidate = models.ForeignKey(
        IntakeCandidate, on_delete=models.PROTECT, related_name="customer_events"
    )
    event_type = models.CharField(max_length=24, choices=Kind.choices)
    occurred_on = models.DateField()
    payload = models.JSONField(default=dict)
    source_refs = models.JSONField(default=dict)
    dedupe_key = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["occurred_on", "created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["source_candidate", "event_type"], name="uniq_customer_event_candidate_type"
            ),
        ]

    def save(self, *args, **kwargs):
        if (
            self.alias.decision != CustomerAlias.Decision.CONFIRMED
            or self.alias.customer_id != self.customer_id
        ):
            raise ValidationError("客户事件必须绑定已确认且归属一致的别名。")
        return super().save(*args, **kwargs)


class CustomerMetricSnapshot(AppendOnlyModel):
    class Kind(models.TextChoices):
        ORDER_INTERVAL_MEDIAN_DAYS = "order_interval_median_days", "Order interval median days"
        SILENCE_DAYS = "silence_days", "Silence days"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="metric_snapshots")
    metric_key = models.CharField(max_length=64, choices=Kind.choices)
    metric_version = models.CharField(max_length=64)
    as_of = models.DateField()
    window_start = models.DateField()
    window_end = models.DateField()
    value = models.DecimalField(max_digits=18, decimal_places=6, null=True, blank=True)
    unit = models.CharField(max_length=16)
    coverage = models.JSONField(default=dict)
    input_event_ids = models.JSONField(default=list)
    inputs_hash = models.CharField(max_length=64)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["customer_id", "metric_key", "-as_of", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["customer", "metric_key", "metric_version", "as_of", "inputs_hash"],
                name="uniq_customer_metric_inputs",
            ),
        ]


class CustomerPrediction(models.Model):
    class Kind(models.TextChoices):
        SILENCE_FOLLOWUP = "silence_followup", "Silence follow-up"

    class Result(models.TextChoices):
        INSUFFICIENT_DATA = "insufficient_data", "Insufficient data"
        NOT_RECOMMENDED = "not_recommended", "Not recommended"
        RECOMMENDED = "recommended", "Recommended"

    class Outcome(models.TextChoices):
        PENDING = "pending", "Pending"
        ORDER_PLACED = "order_placed", "Order placed"
        NO_ORDER = "no_order", "No order"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="predictions")
    prediction_type = models.CharField(max_length=40, choices=Kind.choices)
    predicted_on = models.DateField()
    horizon_days = models.PositiveIntegerField(default=30)
    result = models.CharField(max_length=24, choices=Result.choices)
    rule_id = models.CharField(max_length=64)
    rule_version = models.CharField(max_length=64)
    input_snapshot = models.JSONField(default=dict)
    inputs_hash = models.CharField(max_length=64)
    outcome = models.CharField(max_length=24, choices=Outcome.choices, default=Outcome.PENDING)
    resolved_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-predicted_on", "-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["customer", "prediction_type", "rule_version", "predicted_on", "inputs_hash"],
                name="uniq_customer_prediction_inputs",
            ),
        ]


class CustomerAction(models.Model):
    class Kind(models.TextChoices):
        FOLLOW_UP = "follow_up", "Follow up"

    class Status(models.TextChoices):
        SUGGESTED = "suggested", "Suggested"
        ACCEPTED = "accepted", "Accepted"
        COMPLETED = "completed", "Completed"
        DISMISSED = "dismissed", "Dismissed"

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    customer = models.ForeignKey(Customer, on_delete=models.PROTECT, related_name="actions")
    prediction = models.ForeignKey(CustomerPrediction, on_delete=models.PROTECT, related_name="actions")
    action_type = models.CharField(max_length=32, choices=Kind.choices)
    suggestion = models.TextField()
    due_on = models.DateField(null=True, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.SUGGESTED)
    note = models.TextField(blank=True, default="")
    decided_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(fields=["prediction", "action_type"], name="uniq_customer_action_prediction"),
        ]


class MaterialItem(models.Model):
    """物料主数据（人工维护 / 打表导入 / 演示种子），是物料核对规则的比对基准。

    主数据允许人工修订（改名、停用），不属于证据追加记录；来源持续标注在 source 字段。
    """

    id = models.CharField(primary_key=True, max_length=32, default=hex_uuid, editable=False)
    item_code = models.CharField(max_length=140, unique=True)
    item_name = models.CharField(max_length=200)
    item_group = models.CharField(max_length=120)
    stock_uom = models.CharField(max_length=64)
    aliases = models.JSONField(default=list, blank=True)
    disabled = models.BooleanField(default=False)
    source = models.CharField(max_length=64, default="manual")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["item_code"]
