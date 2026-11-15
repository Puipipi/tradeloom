from __future__ import annotations

from datetime import date, datetime

from django.db.models import Q

from workbench.intake.schemas import FIELD_SCHEMAS, MappingError
from workbench.materials.rules import material_check
from workbench.models import (
    EvidenceRecord,
    IntakeCandidate,
    ProductionRequirementDraft,
    ProductionRequirementRevision,
    WorkbookSheetSnapshot,
    WorkbookSnapshot,
)

from .calculations import packaging_check, source_arithmetic_check
from .schemas import REQUIREMENT_FIELDS, validate_requirement_fields


def _candidate_field_value(field_type: str, value: object):
    if field_type == "text":
        return value if isinstance(value, str) else None
    if field_type == "decimal":
        return value if isinstance(value, str) else None
    if field_type == "date":
        if isinstance(value, dict) and value.get("type") in {"date", "datetime"}:
            candidate = value.get("iso")
            if isinstance(candidate, str):
                return candidate[:10]
        if isinstance(value, (date, datetime)):
            return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    return None


def _valid_locator(candidate: IntakeCandidate, field_key: str, locator: object):
    if not isinstance(locator, dict):
        return None
    expected = candidate.provenance.get(field_key, [])
    if not isinstance(expected, list):
        return None
    sheet_index = locator.get("sheet_index")
    coordinate = locator.get("coordinate")
    snapshot_id = locator.get("snapshot_id")
    snapshot = candidate.mapping_revision.snapshot
    if (type(sheet_index) is not int or not isinstance(coordinate, str) or
            snapshot_id != snapshot.pk or locator.get("source_id") != snapshot.source_id or
            locator.get("source_sha256") != candidate.source_sha256):
        return None
    if not any(
        isinstance(item, dict) and item.get("snapshot_id") == snapshot.pk and
        item.get("source_id") == snapshot.source_id and item.get("source_sha256") == candidate.source_sha256 and
        item.get("sheet_index") == sheet_index and item.get("coordinate") == coordinate
        for item in expected
    ):
        return None
    sheet = WorkbookSheetSnapshot.objects.filter(snapshot=snapshot, sheet_index=sheet_index).first()
    if sheet is None or not sheet.cells.filter(coordinate=coordinate).exists():
        return None
    return snapshot, sheet, coordinate


def _source_evidence(revision: ProductionRequirementRevision, candidate: IntakeCandidate,
                     field_key: str, locator: dict, evidence_revision: int = 1):
    resolved = _valid_locator(candidate, field_key, locator)
    if resolved is None:
        return None
    snapshot, sheet, coordinate = resolved
    return EvidenceRecord.objects.create(
        requirement_revision=revision, field_key=field_key,
        kind=EvidenceRecord.Kind.SOURCE_RECORD, status=EvidenceRecord.Status.UNVERIFIED,
        summary="source_record", revision=evidence_revision, input_record_ids=[],
        source_snapshot=snapshot, source_sheet=sheet, coordinate=coordinate,
        idempotency_key=f"reqsrc:{revision.pk}:{field_key}:{evidence_revision}", actor="local_workbench",
    )


def seed_revision_from_candidate(candidate: IntakeCandidate):
    schema = FIELD_SCHEMAS.get(candidate.candidate_type)
    if schema is None or candidate.candidate_type != "production_instruction":
        raise MappingError("unsupported_requirement_candidate")
    fields = {key: None for key in REQUIREMENT_FIELDS}
    unresolved = {}
    sources = {}
    candidate_fields = candidate.typed_payload.get("fields")
    if not isinstance(candidate_fields, dict):
        raise MappingError("invalid_requirement_candidate")

    for field_key, field_type in schema.items():
        values = candidate_fields.get(field_key)
        locators = candidate.provenance.get(field_key)
        if not isinstance(values, list) or not isinstance(locators, list) or len(values) != 1 or len(locators) != 1:
            states = ([item.get("state", "invalid") if isinstance(item, dict) else "invalid" for item in values]
                      if isinstance(values, list) and values else ["missing"])
            unresolved[field_key] = {
                "states": states,
                "source_refs": [
                    {"sheet_index": item.get("sheet_index"), "coordinate": item.get("coordinate")}
                    for item in locators if isinstance(item, dict)
                ] if isinstance(locators, list) else [],
            }
            continue
        item = values[0]
        locator = locators[0]
        if not isinstance(item, dict) or item.get("state") != "present":
            unresolved[field_key] = {
                "states": [item.get("state", "invalid") if isinstance(item, dict) else "invalid"],
                "source_refs": [{"sheet_index": locator.get("sheet_index"), "coordinate": locator.get("coordinate")}]
                               if isinstance(locator, dict) else [],
            }
            continue
        value = _candidate_field_value(field_type, item.get("value"))
        resolved = _valid_locator(candidate, field_key, locator)
        try:
            if value is None or resolved is None or (field_type == "text" and not value.strip()):
                raise MappingError("invalid_requirement_fields")
            value = validate_requirement_fields({field_key: value}, allow_partial=True)[field_key]
        except MappingError:
            unresolved[field_key] = {
                "states": ["source_value_unresolved"],
                "source_refs": [{"sheet_index": locator.get("sheet_index"), "coordinate": locator.get("coordinate")}]
                               if isinstance(locator, dict) else [],
            }
            continue
        fields[field_key] = value
        sources[field_key] = locator
    return validate_requirement_fields(fields, allow_partial=False), unresolved, sources


def _evidence_payload(record: EvidenceRecord) -> dict:
    return {
        "id": record.pk, "field_key": record.field_key, "kind": record.kind,
        "status": record.status, "summary": record.summary,
        "revision": record.revision, "input_record_ids": record.input_record_ids,
        "snapshot_id": record.source_snapshot_id,
        "sheet_index": record.source_sheet.sheet_index if record.source_sheet_id else None,
        "coordinate": record.coordinate or None,
        "narrative_source_id": record.narrative_source_id,
        "line_start": record.line_start, "line_end": record.line_end,
        "rule_id": record.rule_id or None, "rule_version": record.rule_version or None,
    }


def revision_payload(revision: ProductionRequirementRevision) -> dict:
    rows = revision.evidence_records.select_related("source_sheet", "narrative_source").order_by("field_key", "revision", "id")
    refs = {}
    for row in rows:
        refs.setdefault(row.field_key, []).append(_evidence_payload(row))
    return {
        "id": revision.pk, "draft_id": revision.draft_id, "revision": revision.revision,
        "status": revision.status, "fields": revision.fields,
        "unresolved_fields": revision.unresolved_fields,
        "source_refs": refs, "confirmed_unit_pair": revision.confirmed_unit_pair,
        "created_at": revision.created_at.isoformat(),
    }


def draft_payload(draft: ProductionRequirementDraft, *, revision=None) -> dict:
    return {
        "id": draft.pk, "source_candidate_id": draft.source_candidate_id,
        "record_kind": draft.record_kind,
        "status": revision.status if revision is not None else draft.status,
        "current_revision": revision.revision if revision is not None else draft.current_revision,
        "created_at": draft.created_at.isoformat(),
    }


def requirement_result(draft: ProductionRequirementDraft, revision: ProductionRequirementRevision) -> dict:
    return {
        "ok": True, "status": "succeeded",
        "draft": draft_payload(draft, revision=revision),
        "revision": revision_payload(revision),
        "source_arithmetic_check": source_arithmetic_check(revision.fields),
        "packaging_check": packaging_check(revision),
        "material_check": material_check(revision.fields),
    }


def validate_input_evidence_ids(candidate: IntakeCandidate, draft: ProductionRequirementDraft, field_key: str,
                                ids: object, *, allowed_kinds=None) -> list[EvidenceRecord]:
    if (not isinstance(ids, list) or not ids or len(ids) > 20 or
            any(not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value)
                for value in ids) or len(set(ids)) != len(ids)):
        raise MappingError("invalid_requirement_evidence")
    rows = list(EvidenceRecord.objects.filter(pk__in=ids).filter(
        Q(candidate=candidate, requirement_revision__isnull=True) |
        Q(candidate__isnull=True, requirement_revision__draft=draft)
    ).only("id", "candidate_id", "requirement_revision_id", "field_key", "kind"))
    schema = FIELD_SCHEMAS["production_instruction"]
    if len(rows) != len(ids) or any(
        row.field_key not in schema or (allowed_kinds is not None and row.kind not in allowed_kinds)
        for row in rows
    ):
        raise MappingError("invalid_requirement_evidence")
    return rows
