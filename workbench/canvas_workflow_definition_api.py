"""Host-only durable storage for canonical Canvas workflow definitions."""

import logging
import json
import re

from django.db import DatabaseError, IntegrityError, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .api import _native_bridge_authorized, _parse_standard_json
from .models import CanvasWorkflowDefinition
from .workflow_definition_validator import (
    MAX_SAFE_INTEGER,
    ValidationUnavailable,
    WorkflowDefinitionInvalid,
    validate_workflow_definition,
)

logger = logging.getLogger(__name__)
WORKFLOW_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,47}\Z')
MAX_REQUEST_BYTES = 2 * 1024 * 1024 + 4096
MAX_PAGE_SIZE = 100


class StoredDefinitionInvalid(ValueError):
    pass


def _response(code, status):
    return JsonResponse({'code': code}, status=status, headers={'Cache-Control': 'no-store'})


def _integer(value, *, maximum=MAX_SAFE_INTEGER):
    if type(value) is not int or value < 0 or value > maximum:
        return False
    return True


def _dto(row):
    if row.document is None:
        document = None
    else:
        try:
            document = json.loads(row.document)
        except (TypeError, json.JSONDecodeError):
            raise StoredDefinitionInvalid() from None
        if not isinstance(document, dict) or document.get('id') != row.workflow_id:
            raise StoredDefinitionInvalid()
    return {
        'workflowId': row.workflow_id,
        'revision': row.revision,
        'definitionRevision': row.definition_revision,
        'document': document,
        'deleted': row.deleted,
        'updatedAt': row.updated_at.isoformat(),
    }


def _query_integer(request, name, default, maximum):
    values = request.GET.getlist(name)
    if len(values) > 1:
        return None
    if not values:
        return default
    value = values[0]
    if not value.isascii() or not value.isdigit() or len(value) > 16:
        return None
    parsed = int(value)
    return parsed if 0 <= parsed <= maximum else None


@csrf_exempt
@require_http_methods(['GET', 'POST', 'DELETE'])
def definitions(request):
    if not _native_bridge_authorized(request):
        return _response('native_bridge_required', 403)
    try:
        if request.method == 'GET':
            return _get(request)
        if len(request.body) > MAX_REQUEST_BYTES:
            return _response('request_too_large', 413)
        body, invalid = _parse_standard_json(request)
        if invalid is not None:
            return _response('invalid_request', 422)
        return _post(body) if request.method == 'POST' else _delete(body)
    except ValidationUnavailable:
        return _response('workflow_validation_unavailable', 503)
    except WorkflowDefinitionInvalid:
        return _response('invalid_workflow', 400)
    except StoredDefinitionInvalid:
        return _response('definition_store_invalid_record', 503)
    except DatabaseError:
        logger.warning('canvas workflow definition storage unavailable')
        return _response('storage_unavailable', 503)


def _get(request):
    if set(request.GET) == {'id'} and len(request.GET.getlist('id')) == 1:
        workflow_id = request.GET['id']
        if not WORKFLOW_ID.fullmatch(workflow_id):
            return _response('invalid_workflow_id', 400)
        row = CanvasWorkflowDefinition.objects.filter(pk=workflow_id).first()
        return JsonResponse(_dto(row), headers={'Cache-Control': 'no-store'}) if row else _response('definition_not_found', 404)
    if set(request.GET) - {'offset', 'limit'}:
        return _response('invalid_query', 400)
    offset = _query_integer(request, 'offset', 0, MAX_SAFE_INTEGER)
    limit = _query_integer(request, 'limit', 50, MAX_PAGE_SIZE)
    if offset is None or limit is None or limit < 1:
        return _response('invalid_query', 400)
    query = CanvasWorkflowDefinition.objects.filter(deleted=False).order_by('workflow_id')
    total = query.count()
    rows = list(query[offset:offset + limit])
    next_offset = offset + len(rows) if offset + len(rows) < total else None
    return JsonResponse({
        'definitions': [_dto(row) for row in rows],
        'total': total,
        'offset': offset,
        'limit': limit,
        'nextOffset': next_offset,
    }, headers={'Cache-Control': 'no-store'})


def _post(body):
    if set(body) != {'document', 'expectedRevision'} or not _integer(body['expectedRevision']):
        return _response('invalid_request', 400)
    document, digest = validate_workflow_definition(body['document'])
    workflow_id = document['id']
    expected = body['expectedRevision']
    try:
        with transaction.atomic():
            row = CanvasWorkflowDefinition.objects.select_for_update().filter(pk=workflow_id).first()
            if row is None:
                if expected != 0:
                    return _response('revision_conflict', 409)
                row = CanvasWorkflowDefinition(
                    workflow_id=workflow_id,
                    revision=1,
                    definition_revision=digest,
                    document=json.dumps(document, ensure_ascii=True, separators=(',', ':')),
                    deleted=False,
                )
                row.save(force_insert=True)
                status = 201
            else:
                if row.revision != expected or row.revision >= MAX_SAFE_INTEGER:
                    return _response('revision_conflict', 409)
                row.revision += 1
                row.definition_revision = digest
                row.document = json.dumps(document, ensure_ascii=True, separators=(',', ':'))
                row.deleted = False
                row.save(update_fields=['revision', 'definition_revision', 'document', 'deleted', 'updated_at'])
                status = 200
    except IntegrityError:
        return _response('revision_conflict', 409)
    return JsonResponse(_dto(row), status=status, headers={'Cache-Control': 'no-store'})


def _delete(body):
    if set(body) != {'workflowId', 'expectedRevision'} or not isinstance(body['workflowId'], str) \
            or not WORKFLOW_ID.fullmatch(body['workflowId']) or not _integer(body['expectedRevision']):
        return _response('invalid_request', 400)
    try:
        with transaction.atomic():
            row = CanvasWorkflowDefinition.objects.select_for_update().filter(pk=body['workflowId']).first()
            if row is None:
                return _response('definition_not_found', 404)
            expected = body['expectedRevision']
            if expected != row.revision:
                return _response('revision_conflict', 409)
            if not row.deleted:
                if row.revision >= MAX_SAFE_INTEGER:
                    return _response('revision_conflict', 409)
                row.revision += 1
                row.document = None
                row.definition_revision = None
                row.deleted = True
                row.save(update_fields=['revision', 'definition_revision', 'document', 'deleted', 'updated_at'])
    except DatabaseError:
        raise
    return JsonResponse(_dto(row), headers={'Cache-Control': 'no-store'})
