from __future__ import annotations

import hashlib
import json
import re
import zipfile
from pathlib import Path

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Count, Max
from django.http import FileResponse, HttpRequest, HttpResponse, JsonResponse
from django.views.decorators.http import require_GET, require_http_methods, require_POST
from openpyxl.utils.cell import coordinate_to_tuple, get_column_letter

from workbench.intake.limits import MAX_SOURCE_BYTES
from workbench.models import (
    EvidenceRecord,
    IntakeCandidate,
    IntakeCandidateLink,
    IntakeMappingRevision,
    IntakeOperationReceipt,
    IntakeSourceVersion,
    NarrativeSourceVersion,
    NarrativeAnnotationRevision,
    WorkbookImageReference,
    WorkbookSnapshot,
)

from .mapping import MappingError, build_mapping, fingerprint
from .narrative_storage import (
    MAX_EVIDENCE_LINE_SPAN,
    MAX_EVIDENCE_SUMMARY_CHARS,
    cleanup_unreferenced_narrative,
    open_narrative,
    prepare_narrative,
    store_narrative,
)
from .schemas import FIELD_SCHEMAS, SCHEMA_VERSION, validate_mapping_shape
from .snapshots import PARSER_VERSION, capture_snapshot
from .storage import cleanup_unreferenced_source, open_source, store_source, verify_source_root

_KEY = re.compile(r"[A-Za-z0-9._:-]{1,200}\Z")
_INTEGER = re.compile(r"(?:0|[1-9][0-9]*)\Z")
_OPAQUE_ID = re.compile(r"[a-f0-9]{32}\Z")
_COORDINATE = re.compile(r"[A-Z]{1,3}[1-9][0-9]{0,6}\Z")
_RULE_ID = re.compile(r"[a-z][a-z0-9_.-]{0,63}\Z")
_RULE_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
MAX_INPUT_RECORD_IDS = 20
_ERROR_STATUSES = {
    "invalid_arguments": 422, "invalid_source": 422, "source_not_found": 404,
    "preview_not_found": 404, "candidate_not_found": 404, "mapping_not_found": 404,
    "idempotency_conflict": 409, "stale_mapping": 409, "source_cell_not_found": 422,
    "snapshot_not_ready": 409, "unavailable": 503,
    "invalid_mapping": 422, "unsupported_schema": 422, "unsupported_candidate_type": 422,
    "invalid_revision": 422, "unknown_field": 422, "empty_mapping": 422,
    "invalid_field_mapping": 422, "invalid_source_cells": 422, "invalid_source_cell": 422,
    "too_many_source_cells": 422, "unsupported_value_type": 422, "invalid_source_hash": 422,
    "private_store_unavailable": 503,
    "invalid_narrative": 422, "narrative_not_found": 404,
    "stale_annotation": 409,
    "stale_product": 409, "target_mismatch": 409,
    "required_identity_fields": 422, "unsupported_candidate_type": 422,
    "invalid_application": 422, "invalid_application_source": 422,
    "unresolved_application_source": 422, "incomplete_source_unit": 422,
    "application_unavailable": 503,
    "invalid_json": 422, "invalid_idempotency_key": 422,
    "invalid_evidence": 422, "evidence_not_found": 404,
}


def _error(code: str, status: int | None = None) -> JsonResponse:
    return JsonResponse({"ok": False, "error_code": code}, status=status or _ERROR_STATUSES.get(code, 400))


def _json_object(request: HttpRequest, max_bytes: int = 65536) -> dict:
    if request.content_type != "application/json" or len(request.body) > max_bytes:
        raise ValueError("invalid_json")

    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_json_key")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("invalid_json")

    try:
        result = json.loads(request.body.decode("utf-8"), object_pairs_hook=unique_pairs, parse_constant=invalid_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise ValueError("invalid_json") from None
    if not isinstance(result, dict):
        raise ValueError("invalid_json")
    return result


def _key(request: HttpRequest) -> str:
    value = request.headers.get("Idempotency-Key", "")
    if not _KEY.fullmatch(value):
        raise ValueError("invalid_idempotency_key")
    return value


def _reserve(key: str, action: str, request_fingerprint: str):
    try:
        with transaction.atomic():
            with transaction.atomic():
                receipt = IntakeOperationReceipt.objects.create(idempotency_key=key, action=action, fingerprint=request_fingerprint)
            return receipt, True
    except IntegrityError:
        # The insert transaction has rolled back before this branch. Re-enter a
        # transaction before locking the winning receipt on PostgreSQL.
        with transaction.atomic():
            receipt = IntakeOperationReceipt.objects.select_for_update().filter(idempotency_key=key).first()
            if receipt is None or receipt.action != action or receipt.fingerprint != request_fingerprint:
                raise MappingError("idempotency_conflict") from None
            return receipt, False


def _complete(receipt, result_type: str, result_id: str):
    receipt.state = IntakeOperationReceipt.State.SUCCEEDED
    receipt.result_type = result_type
    receipt.result_id = result_id
    receipt.error_code = ""
    receipt.save(update_fields=["state", "result_type", "result_id", "error_code", "updated_at"])


def _fail(receipt, code: str):
    receipt.state = IntakeOperationReceipt.State.FAILED
    receipt.error_code = code
    receipt.save(update_fields=["state", "error_code", "updated_at"])


def _fail_upload_if_reserved(receipt_id: str | None, code: str) -> None:
    if not receipt_id:
        return
    try:
        with transaction.atomic():
            receipt = IntakeOperationReceipt.objects.select_for_update().filter(pk=receipt_id).first()
            if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
                _fail(receipt, code)
    except Exception:
        # Preserve the existing receipt state if its actual database state cannot be read or updated.
        return


def _source_payload(source: IntakeSourceVersion) -> dict:
    display_name = Path(source.original_name or "").name.strip()
    if not display_name or display_name in {".", ".."}:
        display_name = f"工作簿-{source.pk[:8]}.xlsx"
    snapshots = source.snapshots.annotate(cell_reference_count=Count("sheets__cells"))
    return {
        "id": source.pk, "sha256": source.sha256, "byte_size": source.byte_size,
        "display_name": display_name,
        "received_at": source.received_at.isoformat(),
        "snapshots": [{"id": snap.pk, "parser_version": snap.parser_version, "status": snap.status,
                       "sheet_count": snap.sheet_count, "cell_count": snap.cell_count,
                       "cell_reference_count": snap.cell_reference_count, "error_code": snap.error_code}
                      for snap in snapshots],
    }


def _serialize(obj, *, cell_reference_count: int | None = None):
    if isinstance(obj, IntakeSourceVersion):
        return _source_payload(obj)
    if isinstance(obj, WorkbookSnapshot):
        if cell_reference_count is None:
            cell_reference_count = obj.sheets.aggregate(total=Count("cells"))["total"] or 0
        return {"id": obj.pk, "source_id": obj.source_id, "source_sha256": obj.source.sha256,
                "parser_version": obj.parser_version, "status": obj.status, "error_code": obj.error_code,
                "warnings": obj.warnings, "sheet_count": obj.sheet_count, "cell_count": obj.cell_count,
                "cell_reference_count": cell_reference_count}
    if isinstance(obj, IntakeMappingRevision):
        return {"id": obj.pk, "snapshot_id": obj.snapshot_id, "source_sha256": obj.source_sha256,
                "candidate_type": obj.candidate_type, "schema_version": obj.schema_version,
                "revision": obj.revision, "mapping_sha256": obj.mapping_sha256, "mapping": obj.mapping}
    if isinstance(obj, IntakeCandidate):
        source_name = Path(obj.mapping_revision.snapshot.source.original_name or "").name.strip()
        if not source_name or source_name in {".", ".."}:
            source_name = f"工作簿-{obj.pk[:8]}.xlsx"
        return {"id": obj.pk, "mapping_id": obj.mapping_revision_id, "source_sha256": obj.source_sha256,
                "mapping_revision": obj.mapping_revision.revision,
                "source_display_name": source_name[:200], "source_display_name_truncated": len(source_name) > 200,
                "candidate_type": obj.candidate_type, "schema_version": obj.schema_version, "status": obj.status,
                "fields": obj.typed_payload["fields"], "semantics": obj.typed_payload["semantics"],
                "provenance": obj.provenance}
    if isinstance(obj, IntakeCandidateLink):
        return {"id": obj.pk, "left_candidate_id": obj.left_candidate_id, "right_candidate_id": obj.right_candidate_id,
                "decision": obj.decision, "evidence": obj.evidence, "actor": obj.actor,
                "created_at": obj.created_at.isoformat()}
    if isinstance(obj, NarrativeSourceVersion):
        return {"id": obj.pk, "sha256": obj.sha256, "byte_size": obj.byte_size,
                "line_count": obj.line_count, "display_name": obj.display_name,
                "received_at": obj.received_at.isoformat()}
    if isinstance(obj, EvidenceRecord):
        return {"id": obj.pk, "candidate_id": obj.candidate_id, "field_key": obj.field_key,
                "kind": obj.kind, "status": obj.status, "summary": obj.summary,
                "revision": obj.revision, "input_record_ids": obj.input_record_ids,
                "snapshot_id": obj.source_snapshot_id,
                "sheet_index": obj.source_sheet.sheet_index if obj.source_sheet_id else None,
                "coordinate": obj.coordinate or None,
                "narrative_source_id": obj.narrative_source_id,
                "line_start": obj.line_start, "line_end": obj.line_end,
                "rule_id": obj.rule_id or None, "rule_version": obj.rule_version or None}
    raise TypeError("unsupported intake result")


def _receipt_replay(receipt, result_key: str):
    if receipt.state == IntakeOperationReceipt.State.FAILED:
        return _error(receipt.error_code or "invalid_source")
    if receipt.state != IntakeOperationReceipt.State.SUCCEEDED:
        return JsonResponse({"ok": True, "status": "pending", "operation_id": receipt.pk}, status=202)
    model = {"source": IntakeSourceVersion, "preview": WorkbookSnapshot, "mapping": IntakeMappingRevision,
             "candidate": IntakeCandidate, "link": IntakeCandidateLink,
             "narrative": NarrativeSourceVersion, "evidence": EvidenceRecord}.get(receipt.result_type)
    obj = model.objects.filter(pk=receipt.result_id).first() if model else None
    if obj is None:
        return _error("unavailable", 503)
    return JsonResponse({"ok": True, "status": "succeeded", result_key: _serialize(obj)}, status=200)


@require_GET
def sources(request: HttpRequest) -> JsonResponse:
    if set(request.GET.keys()) - {"offset", "limit"}:
        return _error("invalid_arguments")
    if any(len(request.GET.getlist(key)) != 1 for key in request.GET.keys()):
        return _error("invalid_arguments")
    try:
        offset = request.GET.get("offset", "0")
        limit = request.GET.get("limit", "100")
        if not _INTEGER.fullmatch(offset) or not _INTEGER.fullmatch(limit):
            return _error("invalid_arguments")
        offset, limit = int(offset), int(limit)
        if offset > 100000 or not 1 <= limit <= 100:
            return _error("invalid_arguments")
    except (TypeError, ValueError):
        return _error("invalid_arguments")
    rows = list(IntakeSourceVersion.objects.prefetch_related("snapshots").order_by("-received_at", "-id")[offset:offset + limit + 1])
    return JsonResponse({
        "ok": True,
        "sources": [_source_payload(source) for source in rows[:limit]],
        "next_offset": offset + limit if len(rows) > limit else None,
    })


@require_http_methods(["GET", "POST"])
def source_collection(request: HttpRequest) -> JsonResponse:
    if request.method == "POST":
        return upload_source(request)
    return sources(request)


def _narrative_page(request: HttpRequest) -> tuple[int, int] | None:
    if (set(request.GET.keys()) - {"offset", "limit"} or
            any(len(request.GET.getlist(key)) != 1 for key in request.GET.keys())):
        return None
    offset = request.GET.get("offset", "0")
    limit = request.GET.get("limit", "50")
    if not _INTEGER.fullmatch(offset) or not _INTEGER.fullmatch(limit):
        return None
    offset, limit = int(offset), int(limit)
    if offset > 100000 or not 1 <= limit <= 100:
        return None
    return offset, limit


@require_GET
def narratives(request: HttpRequest) -> JsonResponse:
    page = _narrative_page(request)
    if page is None:
        return _error("invalid_arguments")
    offset, limit = page
    rows = list(NarrativeSourceVersion.objects.order_by("-received_at", "-id")[offset:offset + limit + 1])
    from .narrative_annotations import current_for_sources
    annotations = current_for_sources([row.pk for row in rows[:limit]])
    sources = []
    for row in rows[:limit]:
        source_payload = _serialize(row)
        source_payload["current_annotation"] = annotations.get(row.pk)
        sources.append(source_payload)
    return JsonResponse({"ok": True, "narratives": sources,
                         "next_offset": offset + limit if len(rows) > limit else None})


@require_GET
def narrative_lines(request: HttpRequest, narrative_id: str) -> JsonResponse:
    from .narrative_annotations import current_for_source

    page = _narrative_page(request)
    if page is None:
        return _error("invalid_arguments")
    offset, limit = page
    source = NarrativeSourceVersion.objects.filter(pk=narrative_id).first()
    if source is None:
        return _error("narrative_not_found")
    try:
        with open_narrative(source.pk) as stream:
            lines = stream.read().decode("utf-8", errors="strict").splitlines()
    except (OSError, ValidationError, UnicodeDecodeError):
        return _error("unavailable", status=503)
    if offset > len(lines):
        return _error("invalid_arguments")
    page_lines = lines[offset:offset + limit]
    result = []
    for index, text in enumerate(page_lines, start=offset + 1):
        truncated = len(text) > 2_000
        result.append({"line_number": index, "text": text[:2_000], "truncated": truncated})
    return JsonResponse({
        "ok": True,
        "source": {**_serialize(source), "current_annotation": current_for_source(source.pk)},
        "lines": result,
        "next_offset": offset + limit if offset + limit < len(lines) else None,
    })


@require_http_methods(["GET", "POST"])
def narrative_collection(request: HttpRequest) -> JsonResponse:
    if request.method == "GET":
        return narratives(request)
    return upload_narrative(request)


@require_http_methods(["GET", "POST"])
def narrative_annotations(request: HttpRequest, narrative_id: str) -> JsonResponse:
    from .narrative_annotations import (
        AnnotationError,
        canonical_payload,
        current_for_source,
        history_page,
        serialize_revision,
    )
    source = NarrativeSourceVersion.objects.filter(pk=narrative_id).first()
    if source is None:
        return _error("narrative_not_found")
    if request.method == "GET":
        page = _narrative_page(request)
        if page is None:
            return _error("invalid_arguments")
        offset, limit = page
        history, next_offset, current = history_page(source.pk, offset, limit)
        return JsonResponse({"ok": True, "source": {"id": source.pk, "sha256": source.sha256},
                             "current": current, "history": history, "next_offset": next_offset})
    try:
        body = _json_object(request, max_bytes=4096)
        payload = canonical_payload(body)
        key = _key(request)
    except (ValueError, AnnotationError) as exc:
        return _error(getattr(exc, "code", "invalid_json"))
    canonical = {
        "action": "narrative_annotation",
        "source_id": source.pk,
        "expected_revision": payload["expected_revision"],
        "source_kind": payload["source_kind"],
        "recording_date": payload["recording_date"].isoformat() if payload["recording_date"] else None,
        "audio_review_status": payload["audio_review_status"],
    }
    try:
        with transaction.atomic():
            NarrativeSourceVersion.objects.select_for_update().get(pk=source.pk)
            receipt, created = _reserve(key, "narrative_annotation", fingerprint(canonical))
            if not created:
                if receipt.state == IntakeOperationReceipt.State.FAILED:
                    return _error(receipt.error_code or "stale_annotation")
                if receipt.state != IntakeOperationReceipt.State.SUCCEEDED:
                    return JsonResponse({"ok": True, "status": "pending", "operation_id": receipt.pk}, status=202)
                annotation = NarrativeAnnotationRevision.objects.filter(pk=receipt.result_id, source_id=source.pk).first()
                if annotation is None:
                    return _error("unavailable", 503)
                return JsonResponse({"ok": True, "status": "succeeded", "annotation": serialize_revision(annotation),
                                     "current": current_for_source(source.pk)}, status=200)
            latest = NarrativeAnnotationRevision.objects.filter(source_id=source.pk).aggregate(value=Max("revision"))["value"] or 0
            if latest != payload["expected_revision"]:
                _fail(receipt, "stale_annotation")
                return _error("stale_annotation")
            annotation = NarrativeAnnotationRevision.objects.create(
                source_id=source.pk,
                revision=latest + 1,
                source_kind=payload["source_kind"],
                recording_date=payload["recording_date"],
                audio_review_status=payload["audio_review_status"],
            )
            _complete(receipt, "narrative_annotation", annotation.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "annotation": serialize_revision(annotation),
                             "current": serialize_revision(annotation)}, status=201)
    except MappingError as exc:
        return _error(exc.code)
    except Exception:
        return _error("unavailable", 503)


@require_POST
def upload_narrative(request: HttpRequest) -> JsonResponse:
    owned_storage_key = None
    try:
        try:
            verify_source_root()
        except ValidationError:
            return _error("private_store_unavailable")
        key = _key(request)
        if set(request.FILES.keys()) != {"file"} or len(request.FILES.getlist("file")) != 1 or request.POST:
            raise ValueError("invalid_upload")
        prepared = prepare_narrative(request.FILES["file"])
        request_fingerprint = fingerprint({"action": "narrative_upload", "sha256": prepared["sha256"]})
        with transaction.atomic():
            receipt, created = _reserve(key, "narrative_upload", request_fingerprint)
            if not created:
                return _receipt_replay(receipt, "narrative")
            narrative, source_created, owned_storage_key = store_narrative(prepared)
            _complete(receipt, "narrative", narrative.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "narrative": _serialize(narrative)},
                            status=201 if source_created else 200)
    except MappingError as exc:
        return _error(exc.code)
    except (ValueError, ValidationError):
        cleanup_unreferenced_narrative(owned_storage_key)
        return _error("invalid_narrative")
    except Exception:
        cleanup_unreferenced_narrative(owned_storage_key)
        return _error("unavailable", 503)


def _evidence_cell(candidate: IntakeCandidate, field_key: str, body: dict, *, require_field_provenance=False):
    if not _OPAQUE_ID.fullmatch(body["snapshot_id"] if isinstance(body.get("snapshot_id"), str) else ""):
        raise MappingError("invalid_evidence")
    snapshot = candidate.mapping_revision.snapshot
    if body["snapshot_id"] != snapshot.pk:
        raise MappingError("invalid_evidence")
    sheet_index = body.get("sheet_index")
    coordinate = body.get("coordinate")
    if type(sheet_index) is not int or sheet_index < 1 or not isinstance(coordinate, str) or not _COORDINATE.fullmatch(coordinate):
        raise MappingError("invalid_evidence")
    try:
        row, column = coordinate_to_tuple(coordinate)
    except ValueError:
        raise MappingError("invalid_evidence") from None
    if get_column_letter(column) + str(row) != coordinate:
        raise MappingError("invalid_evidence")
    sheet = snapshot.sheets.filter(sheet_index=sheet_index).first()
    if sheet is None or not sheet.cells.filter(coordinate=coordinate).exists():
        raise MappingError("invalid_evidence")
    if require_field_provenance:
        provenance = candidate.provenance.get(field_key) if isinstance(candidate.provenance, dict) else None
        if not isinstance(provenance, list) or not any(
                isinstance(ref, dict) and ref.get("snapshot_id") == snapshot.pk and
                ref.get("sheet_index") == sheet_index and ref.get("coordinate") == coordinate
                for ref in provenance):
            raise MappingError("invalid_evidence")
    return snapshot, sheet, coordinate


def _input_evidence_ids(candidate: IntakeCandidate, schema: dict, body: dict, *, allowed_kinds=None) -> list[str]:
    values = body.get("input_record_ids")
    if (not isinstance(values, list) or not values or len(values) > MAX_INPUT_RECORD_IDS or
            any(not isinstance(value, str) or not _OPAQUE_ID.fullmatch(value) for value in values) or
            len(set(values)) != len(values)):
        raise MappingError("invalid_evidence")
    records = list(EvidenceRecord.objects.filter(candidate=candidate, pk__in=values).only(
        "id", "candidate_id", "field_key", "kind"))
    candidate_fields = candidate.typed_payload.get("fields") if isinstance(candidate.typed_payload, dict) else None
    if len(records) != len(values) or any(
            record.candidate_id != candidate.pk or record.field_key not in schema or
            not isinstance(candidate_fields, dict) or record.field_key not in candidate_fields or
            (allowed_kinds is not None and record.kind not in allowed_kinds)
            for record in records):
        raise MappingError("invalid_evidence")
    return values


def _evidence_record(candidate: IntakeCandidate, body: dict, key: str, revision: int) -> EvidenceRecord:
    kind = body.get("kind")
    field_key = body.get("field_key")
    if type(body.get("schema_version")) is not int or body["schema_version"] != 1:
        raise MappingError("invalid_evidence")
    schema = FIELD_SCHEMAS.get(candidate.candidate_type)
    candidate_fields = candidate.typed_payload.get("fields") if isinstance(candidate.typed_payload, dict) else None
    if (not isinstance(kind, str) or kind not in EvidenceRecord.Kind.values or
            not isinstance(field_key, str) or schema is None or field_key not in schema or
            not isinstance(candidate_fields, dict) or field_key not in candidate_fields):
        raise MappingError("invalid_evidence")

    snapshot = sheet = None
    coordinate = ""
    narrative = None
    line_start = line_end = None
    rule_id = ""
    rule_version = ""
    input_record_ids = []
    if kind == EvidenceRecord.Kind.SOURCE_RECORD:
        if set(body) != {"schema_version", "kind", "field_key", "snapshot_id", "sheet_index", "coordinate"}:
            raise MappingError("invalid_evidence")
        snapshot, sheet, coordinate = _evidence_cell(candidate, field_key, body, require_field_provenance=True)
        summary = "source_record"
    elif kind == EvidenceRecord.Kind.OPERATOR_STATEMENT:
        if set(body) != {"schema_version", "kind", "field_key", "narrative_source_id", "line_start", "line_end"}:
            raise MappingError("invalid_evidence")
        narrative_id = body.get("narrative_source_id")
        if not isinstance(narrative_id, str) or not _OPAQUE_ID.fullmatch(narrative_id):
            raise MappingError("narrative_not_found")
        narrative = NarrativeSourceVersion.objects.filter(pk=narrative_id).first()
        if narrative is None:
            raise MappingError("narrative_not_found")
        line_start, line_end = body.get("line_start"), body.get("line_end")
        if (type(line_start) is not int or type(line_end) is not int or line_start < 1 or
                line_end < line_start or line_end > narrative.line_count or
                line_end - line_start + 1 > MAX_EVIDENCE_LINE_SPAN):
            raise MappingError("invalid_evidence")
        summary = "summary_only"
    elif kind == EvidenceRecord.Kind.TEAM_HYPOTHESIS:
        if set(body) != {"schema_version", "kind", "field_key", "snapshot_id", "sheet_index", "coordinate", "summary", "input_record_ids"}:
            raise MappingError("invalid_evidence")
        snapshot, sheet, coordinate = _evidence_cell(candidate, field_key, body)
        input_record_ids = _input_evidence_ids(candidate, schema, body, allowed_kinds={
            EvidenceRecord.Kind.SOURCE_RECORD, EvidenceRecord.Kind.OPERATOR_STATEMENT,
        })
        summary = body.get("summary")
        if not isinstance(summary, str) or not summary.strip() or len(summary) > MAX_EVIDENCE_SUMMARY_CHARS:
            raise MappingError("invalid_evidence")
        summary = summary.strip()
    else:
        if set(body) != {"schema_version", "kind", "field_key", "snapshot_id", "sheet_index", "coordinate", "rule_id", "rule_version", "input_record_ids"}:
            raise MappingError("invalid_evidence")
        snapshot, sheet, coordinate = _evidence_cell(candidate, field_key, body)
        input_record_ids = _input_evidence_ids(candidate, schema, body)
        rule_id = body.get("rule_id")
        if not isinstance(rule_id, str) or not _RULE_ID.fullmatch(rule_id):
            raise MappingError("invalid_evidence")
        rule_version = body.get("rule_version")
        if not isinstance(rule_version, str) or not _RULE_VERSION.fullmatch(rule_version):
            raise MappingError("invalid_evidence")
        # No server-side derivation rule is registered in this slice.
        summary = "unverified"

    return EvidenceRecord(
        candidate=candidate, field_key=field_key, kind=kind,
        status=EvidenceRecord.Status.UNVERIFIED, summary=summary,
        revision=revision, input_record_ids=input_record_ids,
        source_snapshot=snapshot, source_sheet=sheet, coordinate=coordinate,
        narrative_source=narrative, line_start=line_start, line_end=line_end,
        rule_id=rule_id, rule_version=rule_version, idempotency_key=key, actor="local_workbench",
    )


@require_http_methods(["GET", "POST"])
def evidence_collection(request: HttpRequest, candidate_id: str) -> JsonResponse:
    if request.method == "GET":
        return evidence_records(request, candidate_id)
    return create_evidence(request, candidate_id)


@require_POST
def create_evidence(request: HttpRequest, candidate_id: str) -> JsonResponse:
    receipt = None
    try:
        key = _key(request)
        body = _json_object(request)
        with transaction.atomic():
            candidate = IntakeCandidate.objects.select_for_update().filter(pk=candidate_id).first()
            if candidate is None:
                return _error("candidate_not_found")
            request_fingerprint = fingerprint({"action": "evidence", "candidate_id": candidate.pk, "body": body})
            record = _evidence_record(candidate, body, key, 1)
            record.revision = (EvidenceRecord.objects.filter(candidate=candidate, field_key=record.field_key,
                                                              kind=record.kind)
                               .aggregate(value=Max("revision"))["value"] or 0) + 1
            receipt, created = _reserve(key, "evidence", request_fingerprint)
            if not created:
                return _receipt_replay(receipt, "evidence")
            record.save()
            _complete(receipt, "evidence", record.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "evidence": _serialize(record)}, status=201)
    except MappingError as exc:
        return _error(exc.code)
    except (ValueError, ValidationError):
        return _error("invalid_evidence")
    except Exception:
        return _error("unavailable", 503)


@require_POST
def upload_source(request: HttpRequest) -> JsonResponse:
    receipt = None
    created = False
    try:
        try:
            verify_source_root()
        except ValidationError:
            return _error("private_store_unavailable")
        key = _key(request)
        if set(request.FILES.keys()) != {"file"} or len(request.FILES.getlist("file")) != 1 or request.POST:
            raise ValueError("invalid_upload")
        upload = request.FILES["file"]
        if not str(upload.name).lower().endswith(".xlsx"):
            raise ValueError("invalid_upload")
        content = upload.read(MAX_SOURCE_BYTES + 1)
        if not content or len(content) > MAX_SOURCE_BYTES:
            raise ValueError("invalid_upload")
        upload.seek(0)
        request_fingerprint = fingerprint({"action": "upload", "sha256": hashlib.sha256(content).hexdigest()})
        receipt, created = _reserve(key, "upload", request_fingerprint)
        if not created:
            return _receipt_replay(receipt, "source")
        source_created = False
        owned_storage_key = None
        try:
            with transaction.atomic():
                source, source_created = store_source(upload)
                if source_created:
                    owned_storage_key = source.storage_key
                _complete(receipt, "source", source.pk)
        except (ValueError, ValidationError):
            if owned_storage_key is not None:
                cleanup_unreferenced_source(owned_storage_key)
            _fail_upload_if_reserved(receipt.pk, "invalid_source")
            return _error("invalid_source")
        except Exception:
            if owned_storage_key is not None:
                cleanup_unreferenced_source(owned_storage_key)
            _fail_upload_if_reserved(receipt.pk, "unavailable")
            return _error("unavailable", 503)
        return JsonResponse({"ok": True, "status": "succeeded", "source": _source_payload(source)}, status=201 if source_created else 200)
    except MappingError as exc:
        return _error(exc.code)
    except (ValueError, ValidationError):
        if created and receipt is not None:
            _fail_upload_if_reserved(receipt.pk, "invalid_source")
        return _error("invalid_source")
    except Exception:
        if created and receipt is not None:
            _fail_upload_if_reserved(receipt.pk, "unavailable")
        return _error("unavailable", 503)


@require_POST
def create_preview(request: HttpRequest, source_id: str) -> JsonResponse:
    receipt = None
    try:
        key = _key(request)
        if _json_object(request) != {}:
            return _error("invalid_arguments")
        source = IntakeSourceVersion.objects.get(pk=source_id)
        request_fingerprint = fingerprint({"action": "preview", "source_sha256": source.sha256, "parser_version": PARSER_VERSION})
        receipt, created = _reserve(key, "preview", request_fingerprint)
        if not created:
            return _receipt_replay(receipt, "preview")
        snapshot, snapshot_created = capture_snapshot(source)
        _complete(receipt, "preview", snapshot.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "preview": _serialize(snapshot)}, status=201 if snapshot_created else 200)
    except IntakeSourceVersion.DoesNotExist:
        return _error("source_not_found")
    except MappingError as exc:
        return _error(exc.code)
    except (ValueError, ValidationError):
        return _error("invalid_arguments")
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        return _error("unavailable", 503)


@require_GET
def preview(request: HttpRequest, snapshot_id: str) -> JsonResponse:
    window_keys = {"sheet_index", "row_start", "row_count", "col_start", "col_count"}
    query_keys = set(request.GET.keys())
    if any(len(request.GET.getlist(key)) != 1 for key in query_keys):
        return _error("invalid_arguments")
    if query_keys & window_keys:
        if query_keys != window_keys:
            return _error("invalid_arguments")
        raw = {key: request.GET.get(key, "") for key in window_keys}
        if any(not _INTEGER.fullmatch(value) for value in raw.values()):
            return _error("invalid_arguments")
        values = {key: int(value) for key, value in raw.items()}
        sheet_index = values["sheet_index"]
        row_start, row_count = values["row_start"], values["row_count"]
        col_start, col_count = values["col_start"], values["col_count"]
        if (sheet_index < 1 or row_start < 1 or col_start < 1 or
                not 1 <= row_count <= 500 or not 1 <= col_count <= 500 or
                row_count * col_count > 500 or row_start + row_count > 1_048_577 or
                col_start + col_count > 16_385):
            return _error("invalid_arguments")
        snapshot = WorkbookSnapshot.objects.filter(pk=snapshot_id).first()
        if snapshot is None:
            return _error("preview_not_found")
        sheet = snapshot.sheets.filter(sheet_index=sheet_index).first()
        if sheet is None:
            return _error("preview_not_found")
        cell_reference_count = snapshot.sheets.aggregate(total=Count("cells"))["total"] or 0
        coordinates = [
            f"{get_column_letter(column)}{row}"
            for row in range(row_start, row_start + row_count)
            for column in range(col_start, col_start + col_count)
        ]
        found = {
            cell.coordinate: cell
            for cell in sheet.cells.filter(coordinate__in=coordinates)
        }
        rows = []
        for row in range(row_start, row_start + row_count):
            cells = []
            for column in range(col_start, col_start + col_count):
                coordinate = f"{get_column_letter(column)}{row}"
                cell = found.get(coordinate)
                if cell is None:
                    cells.append({"coordinate": coordinate, "blank": True})
                    continue
                cells.append({
                    "coordinate": coordinate, "blank": False,
                    "source_type": cell.source_type, "raw_value": cell.raw_value,
                    "normalized_value": cell.normalized_value, "formula": cell.formula,
                    "cached_value": cell.cached_value, "formula_status": cell.formula_status,
                    "error_code": cell.error_code,
                })
            rows.append(cells)
        image_rows = []
        for image in snapshot.image_references.filter(sheet=sheet):
            coordinate = image.coordinate
            if coordinate:
                from openpyxl.utils.cell import coordinate_to_tuple
                try:
                    image_row, image_col = coordinate_to_tuple(coordinate)
                except ValueError:
                    image_row = image_col = 0
                if not (row_start <= image_row < row_start + row_count and col_start <= image_col < col_start + col_count):
                    continue
            image_rows.append({
                "id": image.pk, "coordinate": coordinate, "anchor": image.anchor,
                "kind": image.kind, "mime_type": image.mime_type,
                "warning_code": image.warning_code,
                "preview_url": f"/api/intake/images/{image.pk}/preview"
                if not image.warning_code and image.mime_type in {"image/png", "image/jpeg"} else None,
            })
        return JsonResponse({
            "ok": True, "preview": _serialize(snapshot, cell_reference_count=cell_reference_count),
            "sheets": [{"sheet_index": item.sheet_index, "title": item.title,
                        "dimensions": item.dimensions, "merged_ranges": item.merged_ranges,
                        "warnings": item.warnings} for item in snapshot.sheets.all()],
            "window": {"sheet_index": sheet_index, "row_start": row_start, "row_count": row_count,
                       "col_start": col_start, "col_count": col_count},
            "rows": rows, "images": image_rows,
            "mapping_revisions": [{"candidate_type": item.candidate_type, "revision": item.revision,
                                   "id": item.pk} for item in snapshot.mapping_revisions.all()],
        })
    if query_keys - {"offset", "limit"}:
        return _error("invalid_arguments")
    offset, limit = request.GET.get("offset", "0"), request.GET.get("limit", "200")
    if not _INTEGER.fullmatch(offset) or not _INTEGER.fullmatch(limit) or int(offset) > 100000 or not 1 <= int(limit) <= 500:
        return _error("invalid_arguments")
    snapshot = WorkbookSnapshot.objects.filter(pk=snapshot_id).first()
    if snapshot is None:
        return _error("preview_not_found")
    cell_reference_count = snapshot.sheets.aggregate(total=Count("cells"))["total"] or 0
    sheets = list(snapshot.sheets.all())
    cells = []
    remaining_offset = int(offset)
    remaining = int(limit)
    for sheet in sheets:
        count = sheet.cells.count()
        if remaining_offset >= count:
            remaining_offset -= count
            continue
        query = list(sheet.cells.order_by("coordinate")[remaining_offset:remaining_offset + remaining])
        for cell in query:
            cells.append({"sheet_index": sheet.sheet_index, "sheet_title": sheet.title, "coordinate": cell.coordinate,
                          "source_type": cell.source_type, "raw_value": cell.raw_value,
                          "normalized_value": cell.normalized_value, "formula": cell.formula,
                          "cached_value": cell.cached_value, "formula_status": cell.formula_status,
                          "error_code": cell.error_code})
        remaining -= len(query)
        remaining_offset = 0
        if remaining <= 0:
            break
    start, end = int(offset), int(offset) + len(cells)
    return JsonResponse({"ok": True, "preview": _serialize(snapshot, cell_reference_count=cell_reference_count),
        "sheets": [{"sheet_index": sheet.sheet_index, "title": sheet.title, "dimensions": sheet.dimensions,
                    "merged_ranges": sheet.merged_ranges, "warnings": sheet.warnings} for sheet in sheets],
        "cells": cells, "next_offset": end if end < cell_reference_count else None,
        "images": [{"id": image.pk, "sheet_index": image.sheet.sheet_index if image.sheet_id else None,
                    "coordinate": image.coordinate, "anchor": image.anchor, "kind": image.kind,
                    "mime_type": image.mime_type, "warning_code": image.warning_code,
                    "preview_url": f"/api/intake/images/{image.pk}/preview"
                    if not image.warning_code and image.mime_type in {"image/png", "image/jpeg"} else None}
                   for image in snapshot.image_references.all()],
        "mapping_revisions": [{"candidate_type": item.candidate_type, "revision": item.revision,
                               "id": item.pk} for item in snapshot.mapping_revisions.all()]})


@require_GET
def image_preview(_request: HttpRequest, image_id: str) -> HttpResponse:
    image = WorkbookImageReference.objects.select_related("snapshot__source").filter(pk=image_id).first()
    if image is None or image.warning_code or image.mime_type not in {"image/png", "image/jpeg"}:
        return _error("source_not_found")
    target = image.target_part
    if not target or target.startswith("/") or ".." in target.split("/") or "\\" in target:
        return _error("source_not_found")
    try:
        with open_source(image.snapshot.source_id) as source:
            with zipfile.ZipFile(source) as archive:
                info = archive.getinfo(target)
                if info.file_size > 8 * 1024 * 1024:
                    return _error("invalid_source")
                content = archive.read(target)
        if len(content) > 8 * 1024 * 1024:
            return _error("invalid_source")
        response = HttpResponse(content, content_type=image.mime_type)
        response["Content-Disposition"] = "inline"
        response["X-Content-Type-Options"] = "nosniff"
        response["Cache-Control"] = "private, no-store"
        return response
    except (KeyError, OSError, zipfile.BadZipFile, ValidationError):
        return _error("source_not_found")


@require_POST
def create_mapping(request: HttpRequest, snapshot_id: str) -> JsonResponse:
    receipt = None
    try:
        key = _key(request)
        body = _json_object(request)
        candidate_type, _schema = validate_mapping_shape(body)
        snapshot = WorkbookSnapshot.objects.select_related("source").get(pk=snapshot_id)
        mapping_payload = {key: body[key] for key in ("schema_version", "candidate_type", "source_sha256", "expected_revision", "fields")}
        request_fingerprint = fingerprint({"action": "mapping", "snapshot_id": snapshot_id,
                                           "source_sha256": snapshot.source.sha256, "mapping": mapping_payload})
        build_mapping(snapshot, body)
        with transaction.atomic():
            receipt, created = _reserve(key, "mapping", request_fingerprint)
            if not created:
                return _receipt_replay(receipt, "mapping")
            snapshot = WorkbookSnapshot.objects.select_for_update().select_related("source").get(pk=snapshot_id)
            latest = IntakeMappingRevision.objects.filter(snapshot=snapshot, candidate_type=candidate_type).order_by("-revision").first()
            current_revision = latest.revision if latest else 0
            if body["expected_revision"] != current_revision:
                _fail(receipt, "stale_mapping")
                return _error("stale_mapping")
            mapping = IntakeMappingRevision.objects.create(snapshot=snapshot, source_sha256=snapshot.source.sha256,
                candidate_type=candidate_type, schema_version=SCHEMA_VERSION, revision=current_revision + 1,
                mapping=mapping_payload, mapping_sha256=fingerprint(mapping_payload), idempotency_key=key)
            _complete(receipt, "mapping", mapping.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "mapping": _serialize(mapping)}, status=201)
    except WorkbookSnapshot.DoesNotExist:
        return _error("preview_not_found")
    except MappingError as exc:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, exc.code)
        return _error(exc.code)
    except (ValueError, ValidationError):
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "invalid_arguments")
        return _error("invalid_arguments")
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        return _error("unavailable", 503)


@require_POST
def create_candidate(request: HttpRequest, mapping_id: str) -> JsonResponse:
    receipt = None
    try:
        key = _key(request)
        if _json_object(request) != {}:
            return _error("invalid_arguments")
        mapping = IntakeMappingRevision.objects.select_related("snapshot__source").get(pk=mapping_id)
        request_fingerprint = fingerprint({"action": "candidate", "mapping_id": mapping.pk, "mapping_sha256": mapping.mapping_sha256})
        typed_payload, provenance = build_mapping(mapping.snapshot, mapping.mapping)
        with transaction.atomic():
            receipt, created = _reserve(key, "candidate", request_fingerprint)
            if not created:
                return _receipt_replay(receipt, "candidate")
            mapping = IntakeMappingRevision.objects.select_for_update().select_related("snapshot__source").get(pk=mapping_id)
            existing = IntakeCandidate.objects.filter(mapping_revision=mapping).first()
            if existing is not None:
                _complete(receipt, "candidate", existing.pk)
                return JsonResponse({"ok": True, "status": "succeeded", "candidate": _serialize(existing)}, status=200)
            if mapping.source_sha256 != mapping.snapshot.source.sha256:
                _fail(receipt, "stale_mapping")
                return _error("stale_mapping")
            candidate = IntakeCandidate.objects.create(mapping_revision=mapping, source_sha256=mapping.source_sha256,
                candidate_type=mapping.candidate_type, schema_version=mapping.schema_version,
                typed_payload=typed_payload, provenance=provenance, idempotency_key=key)
            _complete(receipt, "candidate", candidate.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "candidate": _serialize(candidate)}, status=201)
    except IntakeMappingRevision.DoesNotExist:
        return _error("mapping_not_found")
    except MappingError as exc:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, exc.code)
        return _error(exc.code)
    except (ValueError, ValidationError):
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "invalid_arguments")
        return _error("invalid_arguments")
    except Exception:
        if receipt is not None and receipt.state == IntakeOperationReceipt.State.RESERVED:
            _fail(receipt, "unavailable")
        return _error("unavailable", 503)


@require_http_methods(["GET", "POST"])
def create_candidate_link(request: HttpRequest, candidate_id: str) -> JsonResponse:
    if request.method == "GET":
        if set(request.GET.keys()) - {"offset", "limit"} or any(
                len(request.GET.getlist(key)) != 1 for key in request.GET.keys()):
            return _error("invalid_arguments")
        try:
            offset, limit = int(request.GET.get("offset", "0")), int(request.GET.get("limit", "50"))
            if offset < 0 or offset > 100000 or not 1 <= limit <= 100:
                return _error("invalid_arguments")
        except ValueError:
            return _error("invalid_arguments")
        row = IntakeCandidate.objects.filter(pk=candidate_id).first()
        if row is None:
            return _error("candidate_not_found")
        links = (IntakeCandidateLink.objects.filter(left_candidate=row) |
                 IntakeCandidateLink.objects.filter(right_candidate=row)).order_by("-created_at", "-id")
        page = list(links[offset:offset + limit + 1])
        return JsonResponse({"ok": True, "links": [_serialize(link) for link in page[:limit]],
                             "next_offset": offset + limit if len(page) > limit else None})
    receipt = None
    try:
        key = _key(request)
        body = _json_object(request)
        if (set(body) not in ({"other_candidate_id", "decision"}, {"other_candidate_id", "decision", "reason"}) or
                not isinstance(body.get("other_candidate_id"), str) or
                not _OPAQUE_ID.fullmatch(body["other_candidate_id"]) or
                not isinstance(body.get("decision"), str) or
                body["decision"] not in IntakeCandidateLink.Decision.values or
                ("reason" in body and (not isinstance(body["reason"], str) or len(body["reason"]) > 1000))):
            return _error("invalid_arguments")
        pair = sorted([candidate_id, body["other_candidate_id"]])
        if pair[0] == pair[1]:
            return _error("invalid_arguments")
        left = IntakeCandidate.objects.get(pk=pair[0])
        right = IntakeCandidate.objects.get(pk=pair[1])
        fingerprint_body = {"action": "candidate_link", "pair": pair, "decision": body["decision"]}
        # Keep the pre-reason request fingerprint byte-for-byte compatible with saved receipts.
        if "reason" in body:
            fingerprint_body["reason"] = body["reason"]
        request_fingerprint = fingerprint(fingerprint_body)
        with transaction.atomic():
            receipt, created = _reserve(key, "candidate_link", request_fingerprint)
            if not created:
                return _receipt_replay(receipt, "link")
            evidence = {"reason": body["reason"]} if "reason" in body else {}
            link = IntakeCandidateLink.objects.create(left_candidate=left, right_candidate=right,
                decision=body["decision"], evidence=evidence, idempotency_key=key)
            _complete(receipt, "link", link.pk)
        return JsonResponse({"ok": True, "status": "succeeded", "link": _serialize(link)}, status=201)
    except (IntakeCandidate.DoesNotExist, IntakeMappingRevision.DoesNotExist):
        return _error("candidate_not_found")
    except MappingError as exc:
        return _error(exc.code)
    except (ValueError, ValidationError):
        return _error("invalid_arguments")
    except IntegrityError:
        return _error("idempotency_conflict")
    except Exception:
        # The receipt and link share an atomic transaction; unexpected storage failures roll both back.
        return _error("unavailable", 503)


@require_GET
def candidates(request: HttpRequest) -> JsonResponse:
    if (set(request.GET.keys()) - {"candidate_type", "offset", "limit", "source_id"} or
            any(len(request.GET.getlist(key)) != 1 for key in request.GET.keys())):
        return _error("invalid_arguments")
    candidate_type = request.GET.get("candidate_type", "")
    if candidate_type and candidate_type not in FIELD_SCHEMAS:
        return _error("invalid_arguments")
    source_id = request.GET.get("source_id", "")
    if source_id and not _OPAQUE_ID.fullmatch(source_id):
        return _error("invalid_arguments")
    if "source_id" in request.GET and not source_id:
        return _error("invalid_arguments")
    try:
        offset, limit = int(request.GET.get("offset", "0")), int(request.GET.get("limit", "50"))
        if offset < 0 or offset > 100000 or not 1 <= limit <= 100:
            return _error("invalid_arguments")
    except ValueError:
        return _error("invalid_arguments")
    rows = IntakeCandidate.objects.all()
    if candidate_type:
        rows = rows.filter(candidate_type=candidate_type)
    if source_id:
        rows = rows.filter(mapping_revision__snapshot__source_id=source_id)
    rows = list(rows[offset:offset + limit + 1])
    return JsonResponse({"ok": True, "candidates": [_serialize(row) for row in rows[:limit]],
                         "next_offset": offset + limit if len(rows) > limit else None})


@require_GET
def candidate(request: HttpRequest, candidate_id: str) -> JsonResponse:
    if request.GET:
        return _error("invalid_arguments")
    row = IntakeCandidate.objects.filter(pk=candidate_id).first()
    if row is None:
        return _error("candidate_not_found")
    links = (IntakeCandidateLink.objects.filter(left_candidate=row) |
             IntakeCandidateLink.objects.filter(right_candidate=row)).order_by("-created_at", "-id")
    preview = list(links[:21])
    return JsonResponse({"ok": True, "candidate": _serialize(row),
                         "links": [_serialize(link) for link in preview[:20]],
                         "links_next_offset": 20 if len(preview) > 20 else None})


@require_GET
def evidence_records(request: HttpRequest, candidate_id: str) -> JsonResponse:
    if (set(request.GET.keys()) - {"offset", "limit"} or
            any(len(request.GET.getlist(key)) != 1 for key in request.GET.keys())):
        return _error("invalid_arguments")
    page = _narrative_page(request)
    if page is None:
        return _error("invalid_arguments")
    offset, limit = page
    candidate_row = IntakeCandidate.objects.filter(pk=candidate_id).first()
    if candidate_row is None:
        return _error("candidate_not_found")
    rows = list(candidate_row.evidence_records.select_related("source_sheet", "narrative_source")
                .order_by("created_at", "id")[offset:offset + limit + 1])
    return JsonResponse({"ok": True, "evidence": [_serialize(row) for row in rows[:limit]],
                         "next_offset": offset + limit if len(rows) > limit else None})


@require_GET
def download_source(_request: HttpRequest, source_id: str):
    source = IntakeSourceVersion.objects.filter(pk=source_id).first()
    if source is None:
        return _error("source_not_found")
    try:
        stream = open_source(source.pk)
    except ValidationError:
        return _error("source_not_found")
    response = FileResponse(stream, as_attachment=True, filename=f"workbook-{source.pk}.xlsx",
                            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response
