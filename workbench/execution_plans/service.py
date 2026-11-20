from __future__ import annotations

from pathlib import Path

from workbench.models import EvidenceRecord, ExecutionPlanRevision, IntakeCandidate, ProductionRequirementRevision
from workbench.intake.schemas import FIELD_SCHEMAS
from workbench.requirements.service import revision_payload

from .schemas import MAX_SOURCE_VALUE_CHARS


def _validate_requirement_evidence(requirement_revision: ProductionRequirementRevision, plan: dict) -> None:
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


def _bounded_typed_value(value: object) -> dict:
    if not isinstance(value, dict) or set(value) - {"state", "type", "value"}:
        return {"state": "unknown", "truncated": True}
    result = {key: value[key] for key in ("state", "type", "value") if key in value}
    if "value" in result and isinstance(result["value"], str) and len(result["value"]) > MAX_SOURCE_VALUE_CHARS:
        result["value"] = result["value"][:MAX_SOURCE_VALUE_CHARS]
        result["truncated"] = True
    return result


def _freeze_source_references(plan: dict) -> None:
    wanted = {}
    for collection in (plan["materials"], plan["operations"]):
        for item in collection:
            for reference in item.get("supporting_source_inputs", []):
                for evidence_id in reference["evidence_ids"]:
                    if evidence_id in wanted and wanted[evidence_id] != (reference["candidate_id"], reference["field_key"]):
                        raise ValueError("invalid_execution_evidence")
                    wanted[evidence_id] = (reference["candidate_id"], reference["field_key"])
    if not wanted:
        return
    records = EvidenceRecord.objects.filter(pk__in=wanted).select_related(
        "candidate__mapping_revision__snapshot__source", "source_snapshot", "source_sheet__snapshot"
    )
    found = {record.pk: record for record in records}
    if len(found) != len(wanted):
        raise ValueError("invalid_execution_evidence")
    frozen = {}
    for evidence_id, (candidate_id, field_key) in wanted.items():
        record = found[evidence_id]
        candidate = record.candidate
        if (candidate is None or candidate.pk != candidate_id or
                candidate.candidate_type not in {"commercial_source", "labor_analysis"} or
                field_key not in FIELD_SCHEMAS.get(candidate.candidate_type, {}) or
                candidate.status != IntakeCandidate.Status.UNCONFIRMED or
                candidate.mapping_revision.candidate_type != candidate.candidate_type or
                record.field_key != field_key or record.kind != EvidenceRecord.Kind.SOURCE_RECORD or
                record.status != EvidenceRecord.Status.UNVERIFIED or
                record.source_snapshot_id != candidate.mapping_revision.snapshot_id or
                record.source_sheet_id is None or record.source_sheet.snapshot_id != record.source_snapshot_id or
                candidate.source_sha256 != candidate.mapping_revision.source_sha256 or
                candidate.mapping_revision.snapshot.source.sha256 != candidate.source_sha256):
            raise ValueError("invalid_execution_evidence")
        provenance = candidate.provenance.get(field_key) if isinstance(candidate.provenance, dict) else None
        sources = candidate.typed_payload.get("fields", {}).get(field_key) if isinstance(candidate.typed_payload, dict) else None
        matching_index = next((index for index, ref in enumerate(provenance or [])
                               if isinstance(ref, dict) and ref.get("snapshot_id") == record.source_snapshot_id
                               and ref.get("source_sha256") == candidate.source_sha256
                               and ref.get("sheet_index") == record.source_sheet.sheet_index
                               and ref.get("coordinate") == record.coordinate), None)
        if matching_index is None or not isinstance(sources, list) or matching_index >= len(sources):
            raise ValueError("invalid_execution_evidence")
        cell = record.source_sheet.cells.filter(coordinate=record.coordinate).first()
        if cell is None:
            raise ValueError("invalid_execution_evidence")
        frozen[evidence_id] = {
            "candidate_id": candidate.pk, "candidate_type": candidate.candidate_type,
            "source_display_name": (Path(candidate.mapping_revision.snapshot.source.original_name or "").name.strip() or
                                    f"工作簿-{candidate.pk[:8]}.xlsx")[:200],
            "source_display_name_truncated": len(Path(candidate.mapping_revision.snapshot.source.original_name or "").name.strip()) > 200,
            "mapping_id": candidate.mapping_revision_id, "mapping_revision": candidate.mapping_revision.revision,
            "source_id": candidate.mapping_revision.snapshot.source_id,
            "source_sha256": candidate.source_sha256, "snapshot_id": record.source_snapshot_id,
            "field_key": field_key, "evidence_id": record.pk, "evidence_status": record.status,
            "sheet_index": record.source_sheet.sheet_index, "coordinate": record.coordinate,
            "typed_value": _bounded_typed_value(sources[matching_index]),
            "value_refs": [{"cell_id": cell.pk, "snapshot_id": record.source_snapshot_id,
                            "sheet_index": record.source_sheet.sheet_index, "coordinate": record.coordinate}],
        }
    for collection in (plan["materials"], plan["operations"]):
        for item in collection:
            item["supporting_sources"] = [frozen[evidence_id]
                for reference in item.get("supporting_source_inputs", []) for evidence_id in reference["evidence_ids"]]


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


def bind_plan_evidence(requirement_revision: ProductionRequirementRevision, plan: dict) -> None:
    """Validate evidence for a schema-checked plan and freeze source references in place."""
    _validate_requirement_evidence(requirement_revision, plan)
    _freeze_source_references(plan)
