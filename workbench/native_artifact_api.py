"""Paired Host-only native artifact registration and reads."""
import hashlib
import json
from django.http import JsonResponse, HttpResponse
from django.utils.http import content_disposition_header
from django.db import DatabaseError
from django.core.exceptions import ValidationError
import logging
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from .api import _native_bridge_authorized
from .models import CanvasWorkflowRun, NativeArtifactVersion
from .delivery.storage import resolve_artifact_file, DeliveryStorageError
from .native_artifact_service import register_artifact, inspect_content, MAX_NATIVE_ARTIFACT_BYTES
from .native_artifact_validator import ValidationUnavailable


logger = logging.getLogger(__name__)

def rejected():
    return JsonResponse({'code': 'unavailable'}, status=404, headers={'Cache-Control': 'no-store'})

def metadata(row, replayed=False):
    return {'id': str(row.id), 'runId': str(row.run_id), 'nodeId': row.node_id, 'attempt': row.attempt,
        'name': row.display_name, 'mimeType': row.mime_type, 'byteSize': row.byte_size, 'sha256': row.sha256,
        'source': {'sessionId': row.child_session_id, 'seq': row.source_session_seq, 'index': row.file_index,
                   'callId': row.present_call_id, 'turn': row.source_turn}, 'availability': 'ready', 'replayed': replayed}

@csrf_exempt
@require_http_methods(['GET','POST'])
def register(request):
    if not _native_bridge_authorized(request): return rejected()
    if request.method == 'GET': return list_for_run(request)
    try:
        if set(request.POST) != {'metadata'} or set(request.FILES) != {'file'} or len(request.FILES.getlist('file')) != 1:
            raise ValueError('invalid_input')
        raw = request.POST['metadata']
        if len(raw.encode('utf-8')) > 4096: raise ValueError('invalid_input')
        data = json.loads(raw)
        if not isinstance(data, dict) or set(data) != {'runId','nodeId','attempt','sourceSessionSeq','fileIndex','grant'}:
            raise ValueError('invalid_input')
        upload = request.FILES['file']
        if upload.size > MAX_NATIVE_ARTIFACT_BYTES: raise ValueError('artifact_too_large')
        chunks = []; size = 0
        for chunk in upload.chunks():
            size += len(chunk)
            if size > MAX_NATIVE_ARTIFACT_BYTES: raise ValueError('artifact_too_large')
            chunks.append(chunk)
        row, replayed = register_artifact(data['runId'], data['nodeId'], data['attempt'], data['sourceSessionSeq'], data['fileIndex'], b''.join(chunks), data['grant'])
        return JsonResponse(metadata(row, replayed), status=200 if replayed else 201, headers={'Cache-Control': 'no-store'})
    except ValidationUnavailable:
        return JsonResponse({'code':'source_validation_unavailable'}, status=503, headers={'Cache-Control':'no-store'})
    except (DeliveryStorageError, OSError, DatabaseError):
        logger.warning('native artifact storage or database unavailable')
        return JsonResponse({'code':'storage_unavailable'}, status=503, headers={'Cache-Control':'no-store'})
    except (ValueError, TypeError, KeyError, json.JSONDecodeError, CanvasWorkflowRun.DoesNotExist) as exc:
        code = str(exc) if str(exc) in {'invalid_input','artifact_too_large','artifact_conflict','source_unverified','grant_unverified'} else 'invalid_input'
        return JsonResponse({'code': code}, status=409 if code == 'artifact_conflict' else 413 if code == 'artifact_too_large' else 400, headers={'Cache-Control': 'no-store'})

def _verified_content(row):
    path = resolve_artifact_file(row.storage_key)
    if path.stat().st_size > MAX_NATIVE_ARTIFACT_BYTES: raise ValueError('unavailable')
    with path.open('rb') as handle: content = handle.read(MAX_NATIVE_ARTIFACT_BYTES + 1)
    if len(content) > MAX_NATIVE_ARTIFACT_BYTES or len(content) != row.byte_size or hashlib.sha256(content).hexdigest() != row.sha256:
        raise ValueError('unavailable')
    mime, previewable = inspect_content(content)
    if mime != row.mime_type: raise ValueError('unavailable')
    return content, mime, previewable

def list_for_run(request):
    from .canvas_workflow_api import _valid
    try:
        required = {'runId','parentAgentId','parentSessionId'}
        if not required <= set(request.GET) or set(request.GET) - (required | {'offset'}) or any(len(request.GET.getlist(k)) != 1 for k in request.GET):
            return JsonResponse({'code':'invalid_input'},status=400,headers={'Cache-Control':'no-store'})
        run_id, parent, session = (request.GET[k] for k in ('runId','parentAgentId','parentSessionId'))
        offset_text = request.GET.get('offset','0')
        if not parent or not session or len(parent)>256 or len(session)>256 or not offset_text.isascii() or not offset_text.isdigit() or len(offset_text)>15:
            return JsonResponse({'code':'invalid_input'},status=400,headers={'Cache-Control':'no-store'})
        offset=int(offset_text)
        run=CanvasWorkflowRun.objects.filter(pk=run_id).first()
        if run is None: return rejected()
        snapshot=run.snapshot
        if (not _valid(snapshot,run.revision-1) or snapshot.get('id') != str(run.id) or snapshot.get('workflowId') != run.workflow_id
            or snapshot.get('status') != run.status or snapshot.get('executionMode') != run.execution_mode
            or snapshot.get('parentAgentId') != parent or snapshot.get('sessionId') != session): return rejected()
        rows=list(NativeArtifactVersion.objects.filter(run=run).order_by('created_at','id')[offset:offset+11])
        items=[]
        for row in rows[:10]:
            item=metadata(row); item.pop('replayed',None)
            try:
                _, _, supported = _verified_content(row)
                item['previewSupported'] = supported
                if not supported: item['reason'] = 'preview_unsupported'
            except (OSError, DeliveryStorageError, ValueError):
                item.update(availability='unavailable',reason='file_unavailable',previewSupported=False)
            items.append(item)
        return JsonResponse({'runId':str(run.id),'items':items,'nextOffset':offset+10 if len(rows)>10 else None},headers={'Cache-Control':'no-store'})
    except (ValueError, TypeError, ValidationError): return rejected()
    except DatabaseError:
        logger.warning('native artifact list unavailable')
        return JsonResponse({'code':'storage_unavailable'},status=503,headers={'Cache-Control':'no-store'})

@require_http_methods(['GET'])
def read(request, run_id, version_id, action):
    if not _native_bridge_authorized(request) or action not in ('preview','download'): return rejected()
    try:
        row = NativeArtifactVersion.objects.get(pk=version_id, run_id=run_id)
        content, mime, previewable = _verified_content(row)
        if action == 'preview' and not previewable:
            return JsonResponse({'code': 'preview_unsupported'}, status=415, headers={'Cache-Control': 'no-store'})
        response = HttpResponse(content, content_type=mime if action == 'preview' else 'application/octet-stream')
        response['Content-Disposition'] = content_disposition_header(action == 'download', row.display_name)
        response['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'none'"
        response['X-Content-Type-Options'] = 'nosniff'; response['Cache-Control'] = 'no-store'
        return response
    except (NativeArtifactVersion.DoesNotExist, ValueError, OSError, DeliveryStorageError, DatabaseError): return rejected()
