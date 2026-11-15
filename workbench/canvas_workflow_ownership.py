"""Server-side per-run fencing for the paired native workflow store."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import uuid
from datetime import datetime, timezone

from django.core import signing
from django.db import IntegrityError, connections, transaction
from django.db.models import Q
from django.utils.dateparse import parse_datetime

from .models import CanvasWorkflowRun, CanvasWorkflowRunNamespace

PROTOCOL = "canvas-run-owner/v1"
LEASE_TTL_MS = 120_000
RENEW_AFTER_MS = 40_000
MAX_DOMAIN_ENVELOPE_BYTES = 2 * 1024 * 1024
MAX_OWNERSHIP_BODY_BYTES = MAX_DOMAIN_ENVELOPE_BYTES + 16 * 1024
ACTIVE_STATUSES = ("running", "waiting", "interrupted")
CURSOR_SALT = "workbench.canvas-workflow-run-owner.v1"
EPOCH_RE = re.compile(r"[1-9][0-9]{0,18}\Z")
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
MAX_EPOCH = 9_223_372_036_854_775_807


class OwnershipError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


def _wire_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _uuid(value, code="invalid_owner_proof"):
    if not isinstance(value, str):
        raise OwnershipError(code, 400)
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise OwnershipError(code, 400) from None
    if str(parsed) != value:
        raise OwnershipError(code, 400)
    return parsed


def _epoch(value):
    if not isinstance(value, str) or EPOCH_RE.fullmatch(value) is None:
        raise OwnershipError("invalid_owner_epoch", 400)
    parsed = int(value)
    if parsed > MAX_EPOCH:
        raise OwnershipError("invalid_owner_epoch", 400)
    return parsed


def _token_hash(value):
    if not isinstance(value, str) or TOKEN_RE.fullmatch(value) is None:
        raise OwnershipError("invalid_owner_proof", 400)
    try:
        raw = base64.urlsafe_b64decode(value + "=")
    except Exception:
        raise OwnershipError("invalid_owner_proof", 400) from None
    if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != value:
        raise OwnershipError("invalid_owner_proof", 400)
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def _db_now(using):
    with connections[using].cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def _namespace(using):
    try:
        row = CanvasWorkflowRunNamespace.objects.using(using).get(pk=1)
    except CanvasWorkflowRunNamespace.DoesNotExist:
        raise OwnershipError("owner_namespace_unavailable", 503) from None
    return row.namespace_id


def _check_namespace(value, actual):
    if _uuid(value, "invalid_owner_namespace") != actual:
        raise OwnershipError("owner_fenced", 409)


def _snapshot_valid(snapshot, expected):
    from .canvas_workflow_api import _valid

    if not _valid(snapshot, expected):
        raise OwnershipError("invalid_snapshot", 400)


def _fingerprint(run_id, snapshot):
    encoded = json.dumps(
        {"runId": str(run_id), "snapshot": snapshot},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _domain_size(snapshot, expected):
    return len(_wire_bytes({"snapshot": snapshot, "expectedRevision": expected}))


def _proof(body, namespace_id, *, require_epoch=True):
    _check_namespace(body.get("namespaceId"), namespace_id)
    run_id = _uuid(body.get("runId"), "invalid_run_id")
    owner_id = _uuid(body.get("ownerId"))
    epoch = _epoch(body.get("ownerEpoch")) if require_epoch else None
    token_hash = _token_hash(body.get("ownerToken"))
    return run_id, owner_id, epoch, token_hash


def _owned_row(body, namespace_id, *, lock=True, using="default", require_active=True):
    run_id, owner_id, epoch, token_hash = _proof(body, namespace_id)
    queryset = CanvasWorkflowRun.objects.using(using)
    if lock:
        queryset = queryset.select_for_update()
    row = queryset.filter(pk=run_id).first()
    if row is None:
        raise OwnershipError("run_not_found", 404)
    if row.owner_id is None:
        raise OwnershipError("legacy_unmanaged", 409)
    now = _db_now(using)
    if (row.owner_namespace_id != namespace_id or row.owner_id != owner_id
            or row.owner_epoch != epoch or row.owner_fenced_at is not None
            or not hmac.compare_digest(row.owner_token_hash or "", token_hash)):
        raise OwnershipError("owner_fenced", 409)
    if row.owner_released_at is not None and require_active:
        raise OwnershipError("owner_fenced", 409)
    if require_active and (row.owner_lease_expires_at is None or row.owner_lease_expires_at <= now):
        raise OwnershipError("owner_fenced", 409)
    return row, now


def _payload(body, expected):
    snapshot = body.get("snapshot")
    _snapshot_valid(snapshot, expected)
    if _domain_size(snapshot, expected) > MAX_DOMAIN_ENVELOPE_BYTES:
        raise OwnershipError("snapshot_too_large", 413)
    return snapshot


def _response(value, status=200):
    if len(_wire_bytes(value)) > MAX_OWNERSHIP_BODY_BYTES:
        raise OwnershipError("recovery_response_too_large", 413)
    return value, status


def checked_response(value):
    if len(_wire_bytes(value)) > MAX_OWNERSHIP_BODY_BYTES:
        raise OwnershipError("recovery_response_too_large", 413)
    return value


def namespace_descriptor(using="default"):
    namespace_id = _namespace(using)
    cutoff = _db_now(using).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    cursor = signing.dumps(
        {"v": 1, "namespace": str(namespace_id), "cutoff": cutoff, "last": ""},
        salt=CURSOR_SALT,
        compress=True,
    )
    return _response({
        "protocol": PROTOCOL,
        "namespaceId": str(namespace_id),
        "leaseTtlMs": LEASE_TTL_MS,
        "renewAfterMs": RENEW_AFTER_MS,
        "maxDomainEnvelopeBytes": MAX_DOMAIN_ENVELOPE_BYTES,
        "maxResponseBytes": MAX_OWNERSHIP_BODY_BYTES,
        "recoveryCursor": cursor,
    })


def ownership_state(run_id, namespace_value, using="default"):
    namespace_id = _namespace(using)
    _check_namespace(namespace_value, namespace_id)
    parsed_run_id = _uuid(run_id, "invalid_run_id")
    row = CanvasWorkflowRun.objects.using(using).filter(pk=parsed_run_id).first()
    if row is None:
        raise OwnershipError("run_not_found", 404)
    if row.owner_id is None:
        return _response({"protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(row.id),
                          "managed": False, "revision": row.revision, "status": row.status})
    now = _db_now(using)
    active = (row.owner_namespace_id == namespace_id and row.owner_token_hash is not None
              and row.owner_fenced_at is None
              and row.owner_released_at is None and row.owner_lease_expires_at is not None
              and row.owner_lease_expires_at > now)
    return _response({"protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(row.id),
                      "managed": row.owner_namespace_id == namespace_id,
                      "ownerId": str(row.owner_id), "ownerEpoch": str(row.owner_epoch),
                      "leaseExpiresAt": row.owner_lease_expires_at.isoformat() if row.owner_lease_expires_at else None,
                      "released": row.owner_released_at is not None,
                      "fenced": row.owner_token_hash is None,
                      "active": active, "revision": row.revision, "status": row.status})


def _server_token_hash(body):
    return _token_hash(body.get("ownerToken"))


def create_owned(body, using="default"):
    namespace_id = _namespace(using)
    _check_namespace(body.get("namespaceId"), namespace_id)
    run_id = _uuid(body.get("runId"), "invalid_run_id")
    owner_id = _uuid(body.get("ownerId"))
    token_hash = _server_token_hash(body)
    snapshot = body.get("snapshot")
    _snapshot_valid(snapshot, 0)
    if snapshot.get("id") != str(run_id) or snapshot.get("revision") != 1:
        raise OwnershipError("invalid_snapshot", 400)
    if len(_wire_bytes({"snapshot": snapshot, "expectedRevision": 0})) > MAX_DOMAIN_ENVELOPE_BYTES:
        raise OwnershipError("snapshot_too_large", 413)
    fingerprint = _fingerprint(run_id, snapshot)

    def reconcile_existing(row, now):
        if (row.owner_namespace_id != namespace_id or row.owner_id != owner_id
                or not hmac.compare_digest(row.owner_token_hash or "", token_hash)
                or row.owner_create_fingerprint != fingerprint):
            raise OwnershipError("owner_conflict", 409)
        if (row.owner_released_at is not None or row.owner_token_hash is None
                or row.owner_lease_expires_at is None or row.owner_lease_expires_at <= now):
            raise OwnershipError("owner_fenced", 409)
        advanced = row.revision != 1 or row.snapshot != snapshot
        return _response({
            "protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(run_id),
            "ownerId": str(owner_id), "ownerEpoch": str(row.owner_epoch),
            "leaseExpiresAt": row.owner_lease_expires_at.isoformat(),
            "snapshot": row.snapshot, "alreadyAdvanced": advanced,
        }, 200 if advanced else 201)

    try:
        with transaction.atomic(using=using):
            queryset = CanvasWorkflowRun.objects.using(using).select_for_update()
            row = queryset.filter(pk=run_id).first()
            now = _db_now(using)
            if row is not None:
                return reconcile_existing(row, now)
            row = CanvasWorkflowRun(
                id=run_id, workflow_id=snapshot["workflowId"], revision=1,
                status=snapshot["status"], execution_mode=snapshot["executionMode"], snapshot=snapshot,
                owner_namespace_id=namespace_id, owner_id=owner_id, owner_epoch=1,
                owner_token_hash=token_hash, owner_create_fingerprint=fingerprint,
                owner_lease_expires_at=now + __import__("datetime").timedelta(milliseconds=LEASE_TTL_MS),
            )
            row.save(using=using, force_insert=True)
    except IntegrityError:
        try:
            with transaction.atomic(using=using):
                row = CanvasWorkflowRun.objects.using(using).select_for_update().filter(pk=run_id).first()
                now = _db_now(using)
                if row is None:
                    raise OwnershipError("active_workflow_conflict", 409)
                return reconcile_existing(row, now)
        except OwnershipError:
            raise
    return _response({
        "protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(run_id),
        "ownerId": str(owner_id), "ownerEpoch": "1",
        "leaseExpiresAt": row.owner_lease_expires_at.isoformat(), "snapshot": row.snapshot,
        "alreadyAdvanced": False,
    }, 201)


def save_owned(body, using="default"):
    namespace_id = _namespace(using)
    expected = body.get("expectedRevision")
    if type(expected) is not int or expected < 0:
        raise OwnershipError("invalid_revision", 400)
    snapshot = _payload(body, expected)
    run_id = _uuid(body.get("runId"), "invalid_run_id")
    if snapshot.get("id") != str(run_id):
        raise OwnershipError("invalid_snapshot", 400)
    with transaction.atomic(using=using):
        row, _ = _owned_row(body, namespace_id, using=using)
        if snapshot.get("id") != str(row.pk):
            raise OwnershipError("invalid_snapshot", 400)
        if (row.revision != expected or row.workflow_id != snapshot.get("workflowId")
                or row.execution_mode != snapshot.get("executionMode")
                or row.snapshot.get("document") != snapshot.get("document")
                or row.snapshot.get("startedAt") != snapshot.get("startedAt")
                or row.status in {"done", "failed", "cancelled"}):
            raise OwnershipError("revision_conflict", 409)
        row.revision = snapshot["revision"]
        row.status = snapshot["status"]
        row.execution_mode = snapshot["executionMode"]
        row.snapshot = snapshot
        row.save(using=using)
    return _response({"protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(row.id),
                      "ownerId": str(row.owner_id), "ownerEpoch": str(row.owner_epoch),
                      "snapshot": row.snapshot})


def renew_owned(body, using="default"):
    namespace_id = _namespace(using)
    with transaction.atomic(using=using):
        row, now = _owned_row(body, namespace_id, using=using)
        from datetime import timedelta

        row.owner_lease_expires_at = now + timedelta(milliseconds=LEASE_TTL_MS)
        row.save(using=using, update_fields=["owner_lease_expires_at", "updated_at"])
    return _response({
        "protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(row.id),
        "ownerId": str(row.owner_id), "ownerEpoch": str(row.owner_epoch),
        "leaseExpiresAt": row.owner_lease_expires_at.isoformat(),
    })


def release_owned(body, using="default"):
    namespace_id = _namespace(using)
    with transaction.atomic(using=using):
        row, now = _owned_row(body, namespace_id, using=using, require_active=False)
        if row.owner_fenced_at is not None:
            raise OwnershipError("owner_fenced", 409)
        if row.owner_released_at is None:
            if row.owner_lease_expires_at is None or row.owner_lease_expires_at <= now:
                raise OwnershipError("owner_fenced", 409)
            row.owner_released_at = now
            row.owner_lease_expires_at = now
            row.save(using=using, update_fields=["owner_released_at", "owner_lease_expires_at", "updated_at"])
    return _response({"protocol": PROTOCOL, "released": True, "ownerEpoch": str(row.owner_epoch)})


def claim_resumed(body, using="default"):
    namespace_id = _namespace(using)
    _check_namespace(body.get("namespaceId"), namespace_id)
    run_id = _uuid(body.get("runId"), "invalid_run_id")
    owner_id = _uuid(body.get("ownerId"))
    token_hash = _server_token_hash(body)
    expected = body.get("expectedRevision")
    if type(expected) is not int or expected < 0:
        raise OwnershipError("invalid_revision", 400)
    expected_epoch = _epoch(body.get("expectedOwnerEpoch"))
    with transaction.atomic(using=using):
        row = CanvasWorkflowRun.objects.using(using).select_for_update().filter(pk=run_id).first()
        if row is None:
            raise OwnershipError("run_not_found", 404)
        now = _db_now(using)
        if row.owner_id is None:
            raise OwnershipError("legacy_unmanaged", 409)
        if (row.owner_namespace_id != namespace_id or row.owner_epoch != expected_epoch
                or row.revision != expected):
            raise OwnershipError("owner_conflict", 409)
        active = (row.owner_token_hash is not None and row.owner_fenced_at is None
                  and row.owner_released_at is None
                  and row.owner_lease_expires_at is not None
                  and row.owner_lease_expires_at > now)
        if active:
            raise OwnershipError("owner_conflict", 409)
        if row.status not in {"waiting", "interrupted"}:
            raise OwnershipError("revision_conflict", 409)
        if row.owner_epoch >= MAX_EPOCH:
            raise OwnershipError("invalid_owner_epoch", 409)
        row.owner_epoch += 1
        row.owner_id = owner_id
        row.owner_token_hash = token_hash
        row.owner_lease_expires_at = now + __import__("datetime").timedelta(milliseconds=LEASE_TTL_MS)
        row.owner_released_at = None
        row.owner_fenced_at = None
        row.save(using=using, update_fields=["owner_epoch", "owner_id", "owner_token_hash",
                    "owner_lease_expires_at", "owner_released_at", "owner_fenced_at", "updated_at"])
    return _response({"protocol": PROTOCOL, "namespaceId": str(namespace_id), "runId": str(row.id),
                      "ownerId": str(row.owner_id), "ownerEpoch": str(row.owner_epoch),
                      "leaseExpiresAt": row.owner_lease_expires_at.isoformat(), "snapshot": row.snapshot})


def _decode_cursor(value, namespace_id, using):
    try:
        cursor = signing.loads(value, salt=CURSOR_SALT)
        if cursor.get("v") != 1 or cursor.get("namespace") != str(namespace_id):
            raise ValueError
        cutoff = parse_datetime(cursor.get("cutoff", ""))
        if cutoff is None or cutoff.tzinfo is None:
            raise ValueError
        last = cursor.get("last", "")
        if last:
            _uuid(last, "invalid_recovery_cursor")
        return cutoff, last
    except (signing.BadSignature, ValueError, TypeError, AttributeError):
        raise OwnershipError("invalid_recovery_cursor", 400) from None


def _cursor(namespace_id, cutoff, last):
    return signing.dumps({"v": 1, "namespace": str(namespace_id), "cutoff": cutoff.isoformat(), "last": last},
                         salt=CURSOR_SALT, compress=True)


def _recovery_candidates(namespace_id, cutoff, last_id, using):
    queryset = CanvasWorkflowRun.objects.using(using).filter(status__in=ACTIVE_STATUSES)
    if last_id:
        queryset = queryset.filter(id__gt=uuid.UUID(last_id))
    owned_expired = Q(owner_namespace_id=namespace_id, owner_id__isnull=False,
                      owner_token_hash__isnull=False, owner_released_at__isnull=True,
                      owner_lease_expires_at__lte=cutoff)
    replayed = Q(owner_namespace_id=namespace_id, owner_id__isnull=False,
                 owner_fenced_at__gte=cutoff)
    legacy = Q(owner_namespace_id__isnull=True, owner_id__isnull=True,
               owner_epoch__isnull=True, owner_token_hash__isnull=True, created_at__lte=cutoff)
    return queryset.filter(owned_expired | replayed | legacy).order_by("id").first()


def _interrupted_snapshot(snapshot, at, next_revision):
    from copy import deepcopy

    next_snapshot = deepcopy(snapshot)
    events = next_snapshot.get("events")
    if not isinstance(events, list):
        events = []
        next_snapshot["events"] = events
    at_text = at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    document_nodes = {item.get("id"): item for item in next_snapshot.get("document", {}).get("nodes", [])
                      if isinstance(item, dict)}
    for node_id, node in next_snapshot.get("nodes", {}).items():
        if not isinstance(node, dict) or node.get("status") not in {"running", "waiting"}:
            continue
        event = {
            "sequence": len(events) + 1, "workflowRunId": next_snapshot["id"], "nodeId": node_id,
            "attempt": node.get("attempt") if type(node.get("attempt")) is int else None,
            "at": at_text, "bindingRevision": next_snapshot.get("bindingRevision"),
            "definitionRevision": next_snapshot.get("definitionRevision"),
            "parentAgentId": next_snapshot.get("parentAgentId"), "sessionId": next_snapshot.get("sessionId"),
            "requestId": node.get("requestId", next_snapshot.get("requestId")),
            "toolCallId": node.get("toolCallId"), "childId": node.get("childId"),
            "nativeRunId": node.get("nativeRunId"), "source": "ownership-recovery",
            "status": "interrupted", "errorCategory": "OWNER_LEASE_EXPIRED",
        }
        if document_nodes.get(node_id, {}).get("kind") == "review" and isinstance(node.get("reviewState"), dict):
            review = node["reviewState"]
            request = review.get("request")
            node["status"] = "interrupted"
            node["attemptState"] = "review-interrupted"
            node["error"] = "OWNER_LEASE_EXPIRED"
            review["status"] = "interrupted"
            review["error"] = "OWNER_LEASE_EXPIRED"
            event["type"] = "review-node-interrupted"
            event["source"] = "dsh-user-questions"
            event["questionId"] = request.get("questionId") if isinstance(request, dict) else None
            event["requestFingerprint"] = request.get("requestFingerprint") if isinstance(request, dict) else None
            event["reviewRequest"] = request
        else:
            node["status"] = "interrupted"
            node["attemptState"] = "interrupted"
            node["error"] = node.get("error") or "OWNER_LEASE_EXPIRED"
            event["type"] = "node-interrupted"
        events.append(event)
    next_snapshot["status"] = "interrupted"
    next_snapshot["finishedAt"] = at_text
    next_snapshot["revision"] = next_revision
    events.append({
        "sequence": len(events) + 1, "type": "run-interrupted", "at": at_text,
        "requestId": next_snapshot.get("requestId"), "workflowRunId": next_snapshot["id"],
        "nodeId": None, "attempt": None, "bindingRevision": next_snapshot.get("bindingRevision"),
        "definitionRevision": next_snapshot.get("definitionRevision"),
        "parentAgentId": next_snapshot.get("parentAgentId"), "sessionId": next_snapshot.get("sessionId"),
        "toolCallId": None, "childId": None, "nativeRunId": None, "source": "ownership-recovery",
        "status": "interrupted", "errorCategory": "OWNER_LEASE_EXPIRED",
    })
    return next_snapshot


def recover_expired(body, using="default"):
    namespace_id = _namespace(using)
    if not isinstance(body.get("cursor"), str) or len(body["cursor"]) > MAX_OWNERSHIP_BODY_BYTES:
        raise OwnershipError("invalid_recovery_cursor", 400)
    cutoff, last_id = _decode_cursor(body["cursor"], namespace_id, using)
    candidate = _recovery_candidates(namespace_id, cutoff, last_id, using)
    if candidate is None:
        return _response({"protocol": PROTOCOL, "namespaceId": str(namespace_id), "item": None,
                          "nextCursor": None, "complete": True})
    with transaction.atomic(using=using):
        row = CanvasWorkflowRun.objects.using(using).select_for_update().get(pk=candidate.pk)
        now = _db_now(using)
        already_fenced = row.owner_fenced_at is not None and row.owner_fenced_at >= cutoff
        if row.owner_id is None:
            item = {"kind": "unmanaged", "id": str(row.id), "status": row.status, "reason": "legacy_ownerless"}
        elif already_fenced:
            item = {"kind": "recovered", "snapshot": row.snapshot,
                    "previousOwnerEpoch": str(max(1, (row.owner_epoch or 1) - 1)),
                    "newOwnerEpoch": str(row.owner_epoch or 1), "fencedAt": row.owner_fenced_at.isoformat()}
        elif (row.owner_namespace_id != namespace_id or row.owner_released_at is not None
              or row.owner_lease_expires_at is None or row.owner_lease_expires_at > cutoff
              or row.status not in ACTIVE_STATUSES):
            item = {"kind": "unmanaged", "id": str(row.id), "status": row.status, "reason": "not_recoverable"}
        else:
            if row.owner_epoch is None or row.owner_epoch >= MAX_EPOCH:
                raise OwnershipError("invalid_owner_epoch", 409)
            next_snapshot = _interrupted_snapshot(row.snapshot, now, row.revision + 1)
            item = {"kind": "recovered", "snapshot": next_snapshot,
                    "previousOwnerEpoch": str(row.owner_epoch), "newOwnerEpoch": str(row.owner_epoch + 1),
                    "fencedAt": now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
            response = {"protocol": PROTOCOL, "namespaceId": str(namespace_id), "item": item,
                        "nextCursor": _cursor(namespace_id, cutoff, str(row.id)), "complete": False}
            if _domain_size(next_snapshot, row.revision) > MAX_DOMAIN_ENVELOPE_BYTES:
                raise OwnershipError("recovery_response_too_large", 413)
            if len(_wire_bytes(response)) > MAX_OWNERSHIP_BODY_BYTES:
                raise OwnershipError("recovery_response_too_large", 413)
            row.snapshot = next_snapshot
            row.revision += 1
            row.status = "interrupted"
            row.owner_epoch += 1
            row.owner_token_hash = None
            row.owner_lease_expires_at = now
            row.owner_fenced_at = now
            row.save(using=using)
    next_cursor = _cursor(namespace_id, cutoff, str(row.id))
    has_more = _recovery_candidates(namespace_id, cutoff, str(row.id), using) is not None
    return _response({"protocol": PROTOCOL, "namespaceId": str(namespace_id), "item": item,
                      "nextCursor": next_cursor if has_more else None, "complete": not has_more})


def dispatch_owner_action(body, using="default"):
    if not isinstance(body, dict) or body.get("protocol") != PROTOCOL:
        raise OwnershipError("invalid_owner_request", 400)
    action = body.get("action")
    handlers = {
        "create_owned": create_owned,
        "save_owned": save_owned,
        "renew_owned": renew_owned,
        "release_owned": release_owned,
        "claim_resumed": claim_resumed,
        "recover_expired": recover_expired,
    }
    handler = handlers.get(action)
    if handler is None:
        raise OwnershipError("invalid_owner_action", 400)
    return handler(body, using=using)
