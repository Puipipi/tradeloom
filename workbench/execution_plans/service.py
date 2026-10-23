from __future__ import annotations

from workbench.models import EvidenceRecord, ExecutionPlanRevision, ProductionRequirementRevision
from workbench.requirements.service import revision_payload

from .schemas import validate_plan_body


def validate_evidence_binding(requirement_revision: ProductionRequirementRevision, plan: dict) -> None:
    references = list(plan["requirement_refs"])
    for collection in (plan["materials"], plan["operations"]):
        for item in collection:
            references.extend(item["supporting_requirement_inputs"])
    wanted = {}
    for reference in references:
        for evidence_id in reference["evidence_ids"]:
            if evidence_id in wanted and wanted[evidence_id] != reference["field_key"]:
                raise ValueError("invalid_execution_evidence")
            wanted[evidence_id] = reference["field_key"]
    if not wanted:
        return
    rows = EvidenceRecord.objects.filter(pk__in=wanted).only("id", "field_key", "requirement_revision_id")
    found = {row.pk: row for row in rows}
    if len(found) != len(wanted) or any(
        row.requirement_revision_id != requirement_revision.pk or row.field_key != wanted[evidence_id]
        for evidence_id, row in found.items()
    ):
        raise ValueError("invalid_execution_evidence")


def latest_revision(requirement_revision: ProductionRequirementRevision) -> int:
    return requirement_revision.execution_plan_revisions.order_by("-revision").values_list("revision", flat=True).first() or 0


def plan_payload(plan: ExecutionPlanRevision) -> dict:
    requirement = plan.requirement_revision
    latest = latest_revision(requirement)
    draft = requirement.draft
    return {
        "id": plan.pk,
        "requirement_revision_id": requirement.pk,
        "revision": plan.revision,
        "status": ExecutionPlanRevision.Status.DRAFT,
        "requirement_refs": plan.requirement_refs,
        "materials": plan.materials,
        "operations": plan.operations,
        "created_at": plan.created_at.isoformat(),
        "actor": plan.actor,
        "requirement": {
            "id": requirement.pk,
            "draft_id": draft.pk,
            "source_candidate_id": draft.source_candidate_id,
            "record_kind": draft.record_kind,
            "revision": requirement.revision,
            "status": requirement.status,
        },
        "requirement_revision": revision_payload(requirement),
        "latest_revision": latest,
        "is_latest": plan.revision == latest,
        "actual": {"status": "missing"},
    }


def create_plan_payload(requirement_revision: ProductionRequirementRevision, body: dict) -> dict:
    plan = validate_plan_body(body)
    validate_evidence_binding(requirement_revision, plan)
    return plan
