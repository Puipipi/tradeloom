from __future__ import annotations

import json
import re
from django.db import IntegrityError, transaction
from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from workbench.intake.api import _complete, _error, _json_object, _key, _reserve
from workbench.intake.mapping import MappingError, fingerprint
from workbench.intake.narrative_storage import MAX_EVIDENCE_LINE_SPAN, MAX_EVIDENCE_SUMMARY_CHARS
from workbench.intake.schemas import FIELD_SCHEMAS
from workbench.materials.rules import material_check
from workbench.models import (
    EvidenceRecord,
    IntakeCandidate,
    IntakeOperationReceipt,
    NarrativeSourceVersion,
    ProductionRequirementDraft,
    ProductionRequirementRevision,
    WorkbookSheetSnapshot,
    WorkbookSnapshot,
)

from .calculations import packaging_check, source_arithmetic_check
from .schemas import REQUIREMENT_FIELDS, validate_requirement_fields
from .service import (
    _candidate_field_value,
    _valid_locator,
    draft_payload,
    revision_payload,
    requirement_result,
    seed_revision_from_candidate,
    validate_input_evidence_ids,
    _source_evidence,
)


_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_RULE_ID = re.compile(r"[a-z][a-z0-9_.-]{0,63}\Z")
_RULE_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_ERROR_STATUS = {
    "candidate_not_found": 404, "requirement_not_found": 404,
    "unsupported_requirement_candidate": 422, "invalid_requirement_candidate": 422,
    "invalid_requirement_fields": 422, "invalid_requirement_evidence": 422,
    "invalid_requirement": 422, "requirement_exists": 409,
    "idempotency_conflict": 409, "stale_requirement": 409,
    "unresolved_requirement": 409, "requirement_source_value_mismatch": 422,
    "narrative_not_found": 404, "already_confirmed": 409, "unavailable": 503,
}


def _safe_error(code: str, status: int | None = None) -> JsonResponse:
    return _error(code, status=_ERROR_STATUS.get(code, 400) if status is None else status)


def _fail_receipt(receipt: IntakeOperationReceipt, code: str) -> None:
    receipt.state = IntakeOperationReceipt.State.FAILED
    receipt.error_code = code
    receipt.save(update_fields=["state", "error_code", "updated_at"])


def _requirement_page_response(receipt: IntakeOperationReceipt, *, replay=False) -> JsonResponse:
    if receipt.state == IntakeOperationReceipt.State.FAILED:
        return _safe_error(receipt.error_code or "unavailable")
    if receipt.state != IntakeOperationReceipt.State.SUCCEEDED:
        return JsonResponse({"ok": True, "status": "pending", "operation_id": receipt.pk}, status=202)
    revision = ProductionRequirementRevision.objects.select_related("draft").filter(pk=receipt.result_id).first()
    if revision is None:
        return _safe_error("unavailable", 503)
    result = requirement_result(revision.draft, revision)
    return JsonResponse(result, status=200 if replay else 201)


def _revision_page(request: HttpRequest, requirement_id: str) -> JsonResponse:
    if (set(request.GET.keys()) - {"offset", "limit"} or
            any(len(request.GET.getlist(key)) != 1 for key in request.GET.keys())):
        return _safe_error("invalid_requirement")
    offset = request.GET.get("offset", "0")
    limit = request.GET.get("limit", "10")
    if not _INTEGER.fullmatch(offset) or not _INTEGER.fullmatch(limit):
        return _safe_error("invalid_requirement")
    offset, limit = int(offset), int(limit)
    if offset > 100_000 or not 1 <= limit <= 20:
        return _safe_error("invalid_requirement")
    draft = ProductionRequirementDraft.objects.filter(pk=requirement_id).first()
    if draft is None:
        return _safe_error("requirement_not_found")
    rows = list(draft.revisions.prefetch_related("evidence_records").select_related("draft")
                .order_by("-revision")[offset:offset + limit + 1])
    return JsonResponse({
        "ok": True,
        "current_revision": draft.current_revision,
        "revisions": [{**revision_payload(row),
                       "source_arithmetic_check": source_arithmetic_check(row.fields),
                       "packaging_check": packaging_check(row),
                       "material_check": material_check(row.fields)} for row in rows[:limit]],
        "next_offset": offset + limit if len(rows) > limit else None,
    })


def _candidate_locator(candidate: IntakeCandidate, field_key: str, body: dict):
    snapshot_id = body.get("snapshot_id")
    sheet_index = body.get("sheet_index")
    coordinate = body.get("coordinate")
    if (not isinstance(snapshot_id, str) or len(snapshot_id) != 32 or
            type(sheet_index) is not int or not isinstance(coordinate, str)):
        raise MappingError("invalid_requirement_evidence")
    resolved = _valid_locator(candidate, field_key, {
        "snapshot_id": snapshot_id, "sheet_index": sheet_index, "coordinate": coordinate,
        "source_id": candidate.mapping_revision.snapshot.source_id,
        "source_sha256": candidate.source_sha256,
    })
    if resolved is None:
        raise MappingError("invalid_requirement_evidence")
    snapshot, sheet, coordinate = resolved
    cell_value = candidate.typed_payload.get("fields", {}).get(field_key)
    if not isinstance(cell_value, list) or len(cell_value) != 1 or not isinstance(cell_value[0], dict) or cell_value[0].get("state") != "present":
        raise MappingError("invalid_requirement_evidence")
    field_type = FIELD_SCHEMAS["production_instruction"].get(field_key)
    return snapshot, sheet, coordinate, _candidate_field_value(field_type or "text", cell_value[0].get("value"))


def _make_requirement_evidence(candidate: IntakeCandidate, draft: ProductionRequirementDraft,
                                field_key: str, item: dict, desired_value):
    kind = item.get("kind")
    if item.get("field_key") != field_key:
        raise MappingError("invalid_requirement_evidence")
    common = {"kind", "field_key"}
    base = dict(
        field_key=field_key, kind=kind,
        status=EvidenceRecord.Status.UNVERIFIED, revision=1, input_record_ids=[],
        source_snapshot=None, source_sheet=None, coordinate="", narrative_source=None,
        line_start=None, line_end=None, rule_id="", rule_version="",
    )
    if kind == EvidenceRecord.Kind.SOURCE_RECORD:
        if set(item) != common | {"snapshot_id", "sheet_index", "coordinate"}:
            raise MappingError("invalid_requirement_evidence")
        snapshot, sheet, coordinate, _ = _candidate_locator(candidate, field_key, item)
        fields_schema = candidate.typed_payload.get("fields", {})
        raw_values = fields_schema.get(field_key, []) if isinstance(fields_schema, dict) else []
        if len(raw_values) != 1:
            raise MappingError("invalid_requirement_evidence")
        schema_type = FIELD_SCHEMAS["production_instruction"].get(field_key)
        source_value = _candidate_field_value(schema_type or "text", raw_values[0].get("value"))
        if source_value is None or source_value != desired_value:
            raise MappingError("requirement_source_value_mismatch")
        base.update(source_snapshot=snapshot, source_sheet=sheet, coordinate=coordinate, summary="source_record")
    elif kind == EvidenceRecord.Kind.OPERATOR_STATEMENT:
        if set(item) != common | {"narrative_source_id", "line_start", "line_end"}:
            raise MappingError("invalid_requirement_evidence")
        narrative_id = item.get("narrative_source_id")
        if not isinstance(narrative_id, str) or not re.fullmatch(r"[a-f0-9]{32}", narrative_id):
            raise MappingError("narrative_not_found")
        narrative = NarrativeSourceVersion.objects.filter(pk=narrative_id).first()
        if narrative is None:
            raise MappingError("narrative_not_found")
        start, end = item.get("line_start"), item.get("line_end")
        if (type(start) is not int or type(end) is not int or start < 1 or end < start or
                end > narrative.line_count or end - start + 1 > MAX_EVIDENCE_LINE_SPAN):
            raise MappingError("invalid_requirement_evidence")
        base.update(narrative_source=narrative, line_start=start, line_end=end, summary="summary_only")
    elif kind == EvidenceRecord.Kind.TEAM_HYPOTHESIS:
        if set(item) != common | {"summary", "input_record_ids"}:
            raise MappingError("invalid_requirement_evidence")
        records = validate_input_evidence_ids(candidate, draft, field_key, item.get("input_record_ids"), allowed_kinds={
            EvidenceRecord.Kind.SOURCE_RECORD, EvidenceRecord.Kind.OPERATOR_STATEMENT,
        })
        summary = item.get("summary")
        if not isinstance(summary, str) or not summary.strip() or len(summary) > MAX_EVIDENCE_SUMMARY_CHARS:
            raise MappingError("invalid_requirement_evidence")
        base.update(input_record_ids=[record.pk for record in records], summary=summary.strip())
    elif kind == EvidenceRecord.Kind.SYSTEM_DERIVATION:
        if set(item) != common | {"rule_id", "rule_version", "input_record_ids"}:
            raise MappingError("invalid_requirement_evidence")
        records = validate_input_evidence_ids(candidate, draft, field_key, item.get("input_record_ids"))
        rule_id, rule_version = item.get("rule_id"), item.get("rule_version")
        if not isinstance(rule_id, str) or not _RULE_ID.fullmatch(rule_id):
            raise MappingError("invalid_requirement_evidence")
        if not isinstance(rule_version, str) or not _RULE_VERSION.fullmatch(rule_version):
            raise MappingError("invalid_requirement_evidence")
        base.update(input_record_ids=[record.pk for record in records], rule_id=rule_id,
                    rule_version=rule_version, summary="unverified")
    else:
        raise MappingError("invalid_requirement_evidence")
    return base


def _copy_revision_evidence(source: ProductionRequirementRevision, target: ProductionRequirementRevision, *, exclude_fields=()):
    for row in source.evidence_records.all().order_by("field_key", "revision", "id"):
        if row.field_key in exclude_fields:
            continue
        evidence_revision = (EvidenceRecord.objects.filter(requirement_revision=target, field_key=row.field_key,
                                                             kind=row.kind).order_by("-revision").values_list("revision", flat=True).first() or 0) + 1
        EvidenceRecord.objects.create(
            requirement_revision=target, field_key=row.field_key, kind=row.kind,
            status=row.status, summary=row.summary, revision=evidence_revision,
            input_record_ids=list(row.input_record_ids), source_snapshot=row.source_snapshot,
            source_sheet=row.source_sheet, coordinate=row.coordinate,
            narrative_source=row.narrative_source, line_start=row.line_start, line_end=row.line_end,
            rule_id=row.rule_id, rule_version=row.rule_version,
            idempotency_key=f"reqcopy:{target.pk}:{row.field_key}:{row.kind}:{evidence_revision}",
            actor="local_workbench",
        )


@require_http_methods(["GET", "POST"])
def create_requirement_draft(request: HttpRequest, candidate_id: str) -> JsonResponse:
    if request.method == "GET":
        if request.GET:
            return _safe_error("invalid_requirement")
        candidate = IntakeCandidate.objects.filter(pk=candidate_id).first()
        if candidate is None:
            return _safe_error("candidate_not_found")
        if candidate.candidate_type != "production_instruction":
            return _safe_error("unsupported_requirement_candidate")
        draft = ProductionRequirementDraft.objects.filter(source_candidate=candidate).first()
        if draft is None:
            return JsonResponse({"ok": True, "requirement": None})
        revision = draft.revisions.filter(revision=draft.current_revision).first()
        if revision is None:
            return _safe_error("unavailable", 503)
        return JsonResponse({"ok": True, "requirement": requirement_result(draft, revision)})
    try:
        key = _key(request)
        body = _json_object(request)
        if set(body) != {"record_kind"} or body.get("record_kind") not in ProductionRequirementDraft.RecordKind.values:
            return _safe_error("invalid_requirement")
        with transaction.atomic():
            candidate = IntakeCandidate.objects.select_for_update().select_related(
                "mapping_revision__snapshot__source"
            ).filter(pk=candidate_id).first()
            if candidate is None:
                return _safe_error("candidate_not_found")
            if candidate.candidate_type != "production_instruction":
                return _safe_error("unsupported_requirement_candidate")
            request_fingerprint = fingerprint({"action": "requirement_draft", "candidate_id": candidate.pk,
                                               "record_kind": body["record_kind"], "source_sha256": candidate.source_sha256})
            receipt, created = _reserve(key, "requirement_draft", request_fingerprint)
            if not created:
                return _requirement_page_response(receipt, replay=True)
            if ProductionRequirementDraft.objects.filter(source_candidate=candidate).exists():
                receipt.state = IntakeOperationReceipt.State.FAILED
                receipt.error_code = "requirement_exists"
                receipt.save(update_fields=["state", "error_code", "updated_at"])
                return _safe_error("requirement_exists")
            fields, unresolved, sources = seed_revision_from_candidate(candidate)
            draft = ProductionRequirementDraft.objects.create(
                source_candidate=candidate, record_kind=body["record_kind"],
                status=ProductionRequirementDraft.Status.NEEDS_CONFIRMATION, current_revision=1,
            )
            revision = ProductionRequirementRevision.objects.create(
                draft=draft, revision=1, fields=fields, unresolved_fields=unresolved,
                status=ProductionRequirementRevision.Status.NEEDS_CONFIRMATION,
            )
            for field_key, locator in sources.items():
                if _source_evidence(revision, candidate, field_key, locator) is None:
                    raise MappingError("invalid_requirement_evidence")
            _complete(receipt, "production_requirement_revision", revision.pk)
        return _requirement_page_response(receipt)
    except MappingError as exc:
        return _safe_error(exc.code)
    except (ValueError, TypeError):
        return _safe_error("invalid_requirement")
    except IntegrityError:
        return _safe_error("requirement_exists")
    except Exception:
        return _safe_error("unavailable", 503)


@require_GET
def production_requirement_detail(_request: HttpRequest, requirement_id: str) -> JsonResponse:
    draft = ProductionRequirementDraft.objects.filter(pk=requirement_id).first()
    if draft is None:
        return _safe_error("requirement_not_found")
    revision = draft.revisions.filter(revision=draft.current_revision).first()
    if revision is None:
        return _safe_error("unavailable", 503)
    result = requirement_result(draft, revision)
    return JsonResponse(result)


@require_http_methods(["GET", "POST"])
def create_requirement_revision(request: HttpRequest, requirement_id: str) -> JsonResponse:
    if request.method == "GET":
        return _revision_page(request, requirement_id)
    try:
        key = _key(request)
        body = _json_object(request)
        if set(body) != {"expected_revision", "fields", "field_sources"}:
            return _safe_error("invalid_requirement")
        expected_revision = body.get("expected_revision")
        if type(expected_revision) is not int or expected_revision < 1:
            return _safe_error("invalid_requirement")
        fields_patch = validate_requirement_fields(body.get("fields"), allow_partial=True)
        if not fields_patch:
            return _safe_error("invalid_requirement")
        field_sources = body.get("field_sources")
        if not isinstance(field_sources, dict) or set(field_sources) - set(fields_patch):
            return _safe_error("invalid_requirement_evidence")
        with transaction.atomic():
            draft = ProductionRequirementDraft.objects.select_for_update().select_related(
                "source_candidate__mapping_revision__snapshot__source"
            ).filter(pk=requirement_id).first()
            if draft is None:
                return _safe_error("requirement_not_found")
            request_fingerprint = fingerprint({"action": "requirement_revision", "draft_id": draft.pk,
                "expected_revision": expected_revision, "fields": fields_patch, "field_sources": field_sources})
            receipt, created = _reserve(key, "requirement_revision", request_fingerprint)
            if not created:
                return _requirement_page_response(receipt, replay=True)
            if expected_revision != draft.current_revision:
                receipt.state = IntakeOperationReceipt.State.FAILED
                receipt.error_code = "stale_requirement"
                receipt.save(update_fields=["state", "error_code", "updated_at"])
                return _safe_error("stale_requirement")
            previous = draft.revisions.filter(revision=draft.current_revision).first()
            if previous is None:
                _fail_receipt(receipt, "unavailable")
                return _safe_error("unavailable", 503)
            new_fields = dict(previous.fields)
            new_fields.update(fields_patch)
            validated_fields = validate_requirement_fields(new_fields, allow_partial=False)
            unresolved = dict(previous.unresolved_fields)
            candidate = draft.source_candidate
            prepared_by_field = {}
            evidence_fields = set()
            for field_key, new_value in fields_patch.items():
                descriptors = field_sources.get(field_key, [])
                if not isinstance(descriptors, list) or len(descriptors) > 10:
                    raise MappingError("invalid_requirement_evidence")
                if new_value != previous.fields.get(field_key) or descriptors:
                    evidence_fields.add(field_key)
                if field_key not in evidence_fields:
                    continue
                unresolved.pop(field_key, None)
                field_type = REQUIREMENT_FIELDS[field_key]
                missing_required_value = (
                    field_key not in {"customer_ref", "item_ref"} and
                    (new_value is None or (field_type == "text" and not new_value.strip()))
                )
                if missing_required_value:
                    unresolved[field_key] = {"states": ["missing_value"], "source_refs": []}
                elif not descriptors and field_key not in {"customer_ref", "item_ref"}:
                    unresolved[field_key] = {"states": ["value_without_source"], "source_refs": []}
                prepared_by_field[field_key] = []
                for descriptor in descriptors:
                    if not isinstance(descriptor, dict):
                        raise MappingError("invalid_requirement_evidence")
                    record_fields = _make_requirement_evidence(candidate, draft, field_key, descriptor, new_value)
                    prepared_by_field[field_key].append(record_fields)
                kinds = {row["kind"] for row in prepared_by_field[field_key]}
                if not kinds or kinds & {EvidenceRecord.Kind.TEAM_HYPOTHESIS, EvidenceRecord.Kind.SYSTEM_DERIVATION}:
                    unresolved[field_key] = {"states": ["unverified_proposal"], "source_refs": []}
            revision = ProductionRequirementRevision.objects.create(
                draft=draft, revision=draft.current_revision + 1, fields=validated_fields,
                unresolved_fields=unresolved,
                confirmed_unit_pair=(previous.confirmed_unit_pair
                                     if validated_fields.get("unit") == previous.fields.get("unit") and
                                     validated_fields.get("pack_unit") == previous.fields.get("pack_unit") else None),
                status=ProductionRequirementRevision.Status.NEEDS_CONFIRMATION,
            )
            _copy_revision_evidence(previous, revision, exclude_fields=evidence_fields)
            for field_key, rows in prepared_by_field.items():
                for record_fields in rows:
                    latest = EvidenceRecord.objects.filter(
                        requirement_revision=revision, field_key=field_key, kind=record_fields["kind"]
                    ).order_by("-revision").values_list("revision", flat=True).first() or 0
                    next_evidence_revision = latest + 1
                    record_fields.update(
                        requirement_revision=revision, revision=next_evidence_revision,
                        idempotency_key=f"req:{revision.pk}:{field_key}:{record_fields['kind']}:{next_evidence_revision}",
                        actor="local_workbench",
                    )
                    EvidenceRecord.objects.create(**record_fields)
            draft.current_revision = revision.revision
            draft.status = ProductionRequirementDraft.Status.NEEDS_CONFIRMATION
            draft.save(update_fields=["current_revision", "status", "updated_at"])
            _complete(receipt, "production_requirement_revision", revision.pk)
        return _requirement_page_response(receipt)
    except MappingError as exc:
        return _safe_error(exc.code)
    except (ValueError, TypeError):
        return _safe_error("invalid_requirement")
    except IntegrityError:
        return _safe_error("idempotency_conflict", 409)
    except Exception:
        return _safe_error("unavailable", 503)


@require_POST
def confirm_requirement(request: HttpRequest, requirement_id: str) -> JsonResponse:
    # Confirmation is an explicit local operator action. It never writes to ERPNext.
    try:
        key = _key(request)
        body = _json_object(request)
        if set(body) - {"expected_revision", "confirmed_unit_pair"} or "expected_revision" not in body:
            return _safe_error("invalid_requirement")
        expected = body["expected_revision"]
        if type(expected) is not int or expected < 1:
            return _safe_error("invalid_requirement")
        pair = body.get("confirmed_unit_pair")
        if pair is not None and (not isinstance(pair, dict) or set(pair) != {"unit", "pack_unit"}):
            return _safe_error("invalid_requirement")
        with transaction.atomic():
            draft = ProductionRequirementDraft.objects.select_for_update().filter(pk=requirement_id).first()
            if draft is None:
                return _safe_error("requirement_not_found")
            request_fingerprint = fingerprint({"action": "requirement_confirm", "draft_id": draft.pk,
                                                "expected_revision": expected, "confirmed_unit_pair": pair})
            receipt, created = _reserve(key, "requirement_confirm", request_fingerprint)
            if not created:
                return _requirement_page_response(receipt, replay=True)
            if expected != draft.current_revision:
                receipt.state = IntakeOperationReceipt.State.FAILED
                receipt.error_code = "stale_requirement"
                receipt.save(update_fields=["state", "error_code", "updated_at"])
                return _safe_error("stale_requirement")
            previous = draft.revisions.filter(revision=draft.current_revision).first()
            if previous is None:
                _fail_receipt(receipt, "unavailable")
                return _safe_error("unavailable", 503)
            if previous.status == ProductionRequirementRevision.Status.CONFIRMED:
                _fail_receipt(receipt, "already_confirmed")
                return _safe_error("already_confirmed")
            if previous.unresolved_fields:
                _fail_receipt(receipt, "unresolved_requirement")
                return _safe_error("unresolved_requirement")
            if pair is not None:
                if (not isinstance(pair.get("unit"), str) or not isinstance(pair.get("pack_unit"), str) or
                        pair != {"unit": previous.fields.get("unit"), "pack_unit": previous.fields.get("pack_unit")}):
                    _fail_receipt(receipt, "invalid_requirement")
                    return _safe_error("invalid_requirement")
            confirmed = ProductionRequirementRevision.objects.create(
                draft=draft, revision=draft.current_revision + 1, fields=dict(previous.fields),
                unresolved_fields={}, confirmed_unit_pair=pair,
                status=ProductionRequirementRevision.Status.CONFIRMED,
            )
            _copy_revision_evidence(previous, confirmed)
            draft.current_revision = confirmed.revision
            draft.status = ProductionRequirementDraft.Status.CONFIRMED
            draft.save(update_fields=["current_revision", "status", "updated_at"])
            _complete(receipt, "production_requirement_revision", confirmed.pk)
        return _requirement_page_response(receipt)
    except MappingError as exc:
        return _safe_error(exc.code)
    except (ValueError, TypeError):
        return _safe_error("invalid_requirement")
    except IntegrityError:
        return _safe_error("idempotency_conflict", 409)
    except Exception:
        return _safe_error("unavailable", 503)
