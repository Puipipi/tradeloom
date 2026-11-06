"""Content classification for registered native artifacts.

Paired Host-only registration and retrieval are exposed internally. The actual
Host grant and browser integration have not yet been implemented or verified.
"""
from io import BytesIO
import json
import re
from PIL import Image, UnidentifiedImageError

MAX_NATIVE_ARTIFACT_BYTES = 32 * 1024 * 1024

def inspect_content(content: bytes) -> tuple[str, bool]:
    if len(content) > MAX_NATIVE_ARTIFACT_BYTES:
        raise ValueError('artifact_too_large')
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
            kind = image.format
        if kind in ('PNG', 'JPEG'):
            return ('image/png' if kind == 'PNG' else 'image/jpeg', True)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        pass
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        return 'application/octet-stream', False
    if '\x00' in text:
        return 'application/octet-stream', False
    stripped = text.lstrip().lower()
    if stripped.startswith(('<svg', '<?xml', '<!doctype html', '<html')):
        return 'application/octet-stream', False
    return 'text/plain; charset=utf-8', True

def register_artifact(run_id, node_id, attempt, seq, index, content, grant):
    import hashlib
    import uuid
    from django.db import transaction, IntegrityError
    import shutil
    from .models import CanvasWorkflowRun, NativeArtifactVersion
    from .delivery.storage import write_native_artifact
    if len(content) > MAX_NATIVE_ARTIFACT_BYTES:
        raise ValueError('artifact_too_large')
    digest = hashlib.sha256(content).hexdigest()
    mime, _ = inspect_content(content)
    published = None
    body_completed = False
    try:
      with transaction.atomic():
        run = CanvasWorkflowRun.objects.select_for_update().get(pk=run_id)
        snapshot = run.snapshot
        from .canvas_workflow_api import _valid
        if (not _valid(snapshot, run.revision - 1) or snapshot.get('id') != str(run.id)
            or snapshot.get('workflowId') != run.workflow_id or snapshot.get('status') != run.status
            or snapshot.get('executionMode') != run.execution_mode):
            raise ValueError('source_unverified')
        from .native_artifact_validator import validate_native_source
        source = validate_native_source(snapshot, node_id, attempt, seq, index)
        expected_grant = {'sessionId': source['childSessionId'], 'runId': str(run.id), 'nodeId': node_id, 'attempt': attempt, 'sourceSessionSeq': seq, 'fileIndex': index, 'authorized': True}
        if not isinstance(grant, dict) or grant.get('authorized') is not True or any(type(grant.get(k)) is not int for k in ('attempt','sourceSessionSeq','fileIndex')) or set(grant) != set(expected_grant) | {'rootScope'} or any(grant.get(k) != v for k,v in expected_grant.items()) or not isinstance(grant.get('rootScope'), str) or re.fullmatch(r'[a-f0-9]{64}', grant['rootScope']) is None:
            raise ValueError('grant_unverified')
        existing = NativeArtifactVersion.objects.filter(run=run, node_id=node_id, attempt=attempt, source_session_seq=seq, file_index=index).first()
        if existing:
            if existing.sha256 != digest:
                raise ValueError('artifact_conflict')
            body_completed = True
            return existing, True
        version_id = str(uuid.uuid4())
        key, published = write_native_artifact(content, version_id)
        display_name = source['name']
        try:
            row = NativeArtifactVersion.objects.create(id=version_id, run=run, node_id=node_id, attempt=attempt,
            child_session_id=source['childSessionId'], native_run_id=source['nativeRunId'], request_id=source['requestId'], tool_call_id=source['toolCallId'],
            parent_agent_id=source['parentAgentId'], parent_session_id=source['parentSessionId'], binding_revision=source['bindingRevision'], definition_revision=source['definitionRevision'],
            source_session_seq=seq, file_index=index, present_call_id=source['callId'], source_turn=source['turn'],
                grant_root_scope=grant['rootScope'], display_name=display_name, mime_type=mime, byte_size=len(content), sha256=digest, storage_key=key)
        except IntegrityError:
            raise
        body_completed = True
        return row, False
    except Exception:
        # Commit outcome may be unknown after entering transaction exit.
        if published is not None and not body_completed:
            shutil.rmtree(published.parent, ignore_errors=True)
        raise
