from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import IntegrityError, transaction

from workbench.models import ErpNextDraftOperation, EventLog, WorkflowTask

from .client import ErpNextClient, ErpNextError
from .service import normalize_purchase_order_payload, normalize_quotation_payload


_IDEMPOTENCY_KEY = re.compile(r"[^\x00-\x1f\x7f]{1,200}\Z")
_SAFE_ERROR_CODES = frozenset({
    "not_configured", "invalid_configuration", "unavailable", "rate_limited",
    "unauthorized", "forbidden", "http_error", "invalid_response", "not_found", "conflict",
    "invalid_arguments",
})
_MODIFIED_VALUE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?\Z")


def _valid_modified(value: Any) -> bool:
    if not isinstance(value, str) or not _MODIFIED_VALUE.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d %H:%M:%S.%f" if "." in value else "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return False
    return True


class DraftOperationError(ValueError):
    def __init__(self, code: str, message: str, status: int) -> None:
        self.code = code
        self.status = status
        super().__init__(message)


@dataclass(frozen=True)
class DraftOperationResult:
    operation: ErpNextDraftOperation
    created: bool
    remote_current: dict[str, Any] | None
    remote_error: str = ""


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _workflow(value: Any) -> WorkflowTask | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise DraftOperationError("invalid_arguments", "工作流标识无效", 422)
    try:
        return WorkflowTask.objects.get(pk=value)
    except WorkflowTask.DoesNotExist:
        raise DraftOperationError("not_found", "工作流不存在", 404) from None


def _validate_key(value: Any) -> str:
    if not isinstance(value, str) or not _IDEMPOTENCY_KEY.fullmatch(value) or value != value.strip():
        raise DraftOperationError("invalid_arguments", "幂等键格式无效", 422)
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError:
        raise DraftOperationError("invalid_arguments", "幂等键格式无效", 422) from None
    return value


def _fingerprint(*, action: str, instance_id: str, target_id: str, expected_modified: str,
                 payload: dict[str, Any], workflow_id: str) -> tuple[str, str, str]:
    payload_json = _canonical_json(payload)
    payload_sha = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    request_identity = {
        "action": action,
        "instance_id": instance_id,
        "target_operation_id": target_id,
        "expected_modified": expected_modified,
        "payload": payload,
        "workflow_id": workflow_id,
    }
    digest = hashlib.sha256(_canonical_json(request_identity).encode("utf-8")).hexdigest()
    return digest, payload_sha, payload_json


def _reserve_create(
    client: ErpNextClient,
    key: str,
    normalized: dict[str, Any],
    workflow: WorkflowTask | None,
    *,
    doctype: str,
    payload_prefix: dict[str, Any],
):
    instance_id = client.instance_id
    if not isinstance(instance_id, str) or not instance_id:
        raise DraftOperationError("not_configured", "ERPNext 尚未配置", 503)
    operation_payload = {**payload_prefix, **normalized}
    fingerprint, payload_sha, payload_json = _fingerprint(
        action=ErpNextDraftOperation.Action.CREATE,
        instance_id=instance_id,
        target_id="",
        expected_modified="",
        payload=operation_payload,
        workflow_id=workflow.id if workflow else "",
    )
    try:
        with transaction.atomic():
            operation = ErpNextDraftOperation.objects.create(
                instance_id=instance_id,
                idempotency_key=key,
                action=ErpNextDraftOperation.Action.CREATE,
                fingerprint=fingerprint,
                payload_sha256=payload_sha,
                request_payload=json.loads(payload_json),
                workflow=workflow,
                doctype=doctype,
                source=ErpNextDraftOperation.Source.LOCAL_WORKBENCH,
                status=ErpNextDraftOperation.Status.OUTCOME_UNKNOWN,
            )
            EventLog.objects.create(
                task=workflow,
                event_type="erpnext_draft_reserved",
                actor=operation.source,
                payload_summary={
                    "operation_id": operation.id,
                    "action": operation.action,
                    "instance_id": operation.instance_id,
                    "payload_sha256": operation.payload_sha256,
                },
            )
        return operation, True
    except IntegrityError:
        operation = ErpNextDraftOperation.objects.filter(
            instance_id=instance_id, idempotency_key=key,
        ).first()
        if operation is None:
            raise
        if operation.fingerprint != fingerprint:
            raise DraftOperationError("idempotency_conflict", "幂等键已用于不同的请求", 409) from None
        return operation, False


def _reserve_update(
    client: ErpNextClient,
    *,
    key: str,
    normalized: dict[str, Any],
    target_id: str,
    expected_modified: str,
    workflow_id: Any,
    doctype: str,
    payload_prefix: dict[str, Any],
):
    instance_id = client.instance_id
    if not isinstance(instance_id, str) or not instance_id:
        raise DraftOperationError("not_configured", "ERPNext 尚未配置", 503)
    if not isinstance(target_id, str) or not re.fullmatch(r"[0-9a-f]{32}", target_id):
        raise DraftOperationError("invalid_arguments", "目标操作标识无效", 422)
    if not _valid_modified(expected_modified):
        raise DraftOperationError("invalid_arguments", "预期版本格式无效", 422)
    explicit_workflow = _workflow(workflow_id)
    try:
        with transaction.atomic():
            target = ErpNextDraftOperation.objects.select_for_update().get(pk=target_id, doctype=doctype)
            if target.status != ErpNextDraftOperation.Status.SUCCEEDED or not target.remote_name:
                raise DraftOperationError("not_found", "目标操作没有可修改的已确认草稿", 409)
            if target.instance_id != instance_id:
                raise DraftOperationError("conflict", "目标草稿属于其他 ERPNext 实例", 409)
            if explicit_workflow is not None and explicit_workflow.id != target.workflow_id:
                raise DraftOperationError("conflict", "目标草稿与工作流关联不匹配", 409)
            workflow = explicit_workflow or target.workflow
            operation_payload = {**payload_prefix, **normalized}
            fingerprint, payload_sha, payload_json = _fingerprint(
                action=ErpNextDraftOperation.Action.UPDATE,
                instance_id=instance_id,
                target_id=target.id,
                expected_modified=expected_modified,
                payload=operation_payload,
                workflow_id=workflow.id if workflow else "",
            )
            existing = ErpNextDraftOperation.objects.filter(
                instance_id=instance_id, idempotency_key=key,
            ).first()
            if existing is not None:
                if existing.fingerprint != fingerprint:
                    raise DraftOperationError("idempotency_conflict", "幂等键已用于不同的请求", 409)
                return existing, False
            operation = ErpNextDraftOperation.objects.create(
                instance_id=instance_id,
                idempotency_key=key,
                action=ErpNextDraftOperation.Action.UPDATE,
                fingerprint=fingerprint,
                payload_sha256=payload_sha,
                request_payload=json.loads(payload_json),
                expected_modified=expected_modified,
                workflow=workflow,
                target_operation=target,
                doctype=doctype,
                source=ErpNextDraftOperation.Source.LOCAL_WORKBENCH,
                remote_name=target.remote_name,
                status=ErpNextDraftOperation.Status.OUTCOME_UNKNOWN,
            )
            EventLog.objects.create(
                task=workflow,
                event_type="erpnext_draft_reserved",
                actor=operation.source,
                payload_summary={
                    "operation_id": operation.id,
                    "action": operation.action,
                    "instance_id": operation.instance_id,
                    "payload_sha256": operation.payload_sha256,
                    "target_operation_id": target.id,
                    "expected_modified": expected_modified,
                },
            )
        return operation, True
    except ErpNextDraftOperation.DoesNotExist:
        raise DraftOperationError("not_found", "目标操作不存在", 404) from None
    except IntegrityError:
        operation = ErpNextDraftOperation.objects.filter(
            instance_id=instance_id, idempotency_key=key,
        ).first()
        if operation is None:
            raise
        if operation.fingerprint != fingerprint:
            raise DraftOperationError("idempotency_conflict", "幂等键已用于不同的请求", 409) from None
        return operation, False


def _mark_unknown(operation: ErpNextDraftOperation, code: str, *, remote_name: str = "") -> None:
    with transaction.atomic():
        current = ErpNextDraftOperation.objects.select_for_update().get(pk=operation.pk)
        if current.status in {ErpNextDraftOperation.Status.SUCCEEDED, ErpNextDraftOperation.Status.CONFLICT}:
            operation.refresh_from_db()
            return
        current.status = ErpNextDraftOperation.Status.OUTCOME_UNKNOWN
        current.error_code = code if code in _SAFE_ERROR_CODES else "unavailable"
        current.receipt = None
        current.result_ref = {}
        current.remote_modified = ""
        if remote_name and not current.remote_name:
            current.remote_name = remote_name[:255]
        current.save(update_fields=[
            "status", "error_code", "remote_name", "remote_modified", "receipt", "result_ref", "updated_at",
        ])
        EventLog.objects.create(
            task=current.workflow,
            event_type="erpnext_draft_outcome_unknown",
            actor=current.source,
            payload_summary={
                "operation_id": current.id,
                "action": current.action,
                "instance_id": current.instance_id,
                "payload_sha256": current.payload_sha256,
                "error_code": current.error_code,
                "remote_name_known": bool(current.remote_name),
            },
        )
        operation.refresh_from_db()


def _upgrade_legacy_reserved(operation: ErpNextDraftOperation) -> None:
    """Treat pre-change reservations as uncertain; they never receive write permission."""
    with transaction.atomic():
        current = ErpNextDraftOperation.objects.select_for_update().get(pk=operation.pk)
        if current.status == ErpNextDraftOperation.Status.RESERVED:
            current.status = ErpNextDraftOperation.Status.OUTCOME_UNKNOWN
            current.error_code = current.error_code or "unavailable"
            current.save(update_fields=["status", "error_code", "updated_at"])
            EventLog.objects.create(
                task=current.workflow,
                event_type="erpnext_draft_outcome_unknown",
                actor=current.source,
                payload_summary={
                    "operation_id": current.id,
                    "action": current.action,
                    "instance_id": current.instance_id,
                    "payload_sha256": current.payload_sha256,
                    "error_code": current.error_code,
                    "remote_name_known": bool(current.remote_name),
                },
            )
        operation.refresh_from_db()


def _mark_conflict(operation: ErpNextDraftOperation) -> None:
    with transaction.atomic():
        current = ErpNextDraftOperation.objects.select_for_update().get(pk=operation.pk)
        if current.status in {ErpNextDraftOperation.Status.SUCCEEDED, ErpNextDraftOperation.Status.CONFLICT}:
            operation.refresh_from_db()
            return
        current.status = ErpNextDraftOperation.Status.CONFLICT
        current.error_code = "conflict"
        current.receipt = None
        current.result_ref = {}
        current.remote_modified = ""
        current.save(update_fields=[
            "status", "error_code", "receipt", "result_ref", "remote_modified", "updated_at",
        ])
        EventLog.objects.create(
            task=current.workflow,
            event_type="erpnext_draft_conflict",
            actor=current.source,
            payload_summary={
                "operation_id": current.id,
                "action": current.action,
                "instance_id": current.instance_id,
                "payload_sha256": current.payload_sha256,
                "target_operation_id": current.target_operation_id,
                "expected_modified": current.expected_modified,
            },
        )
        operation.refresh_from_db()


_DRAFT_READERS = {
    "Quotation": "get_quotation_draft",
    "Purchase Order": "get_purchase_order_draft",
}


def _current_remote(client: ErpNextClient, operation: ErpNextDraftOperation, *, doctype: str):
    if not operation.remote_name:
        return None, ""
    if client.instance_id != operation.instance_id:
        return None, "instance_mismatch"
    try:
        return getattr(client, _DRAFT_READERS[doctype])(operation.remote_name), ""
    except ErpNextError as exc:
        return None, exc.code if exc.code in _SAFE_ERROR_CODES else "unavailable"
    except Exception:
        return None, "unavailable"


def _decimal_equal(left: Any, right: Any) -> bool:
    try:
        left_number = Decimal(str(left))
        right_number = Decimal(str(right))
    except (InvalidOperation, ValueError):
        return False
    return left_number.is_finite() and right_number.is_finite() and left_number == right_number


def _matches_reserved_payload(operation: ErpNextDraftOperation, record: dict[str, Any], *, doctype: str) -> bool:
    if record.get("truncated_children"):
        return False
    expected = operation.request_payload
    actual = record.get("data", {})
    if (
        operation.action == ErpNextDraftOperation.Action.UPDATE
        and actual.get("modified") == operation.expected_modified
    ):
        # The requested values may already have existed before a timed-out PUT;
        # unchanged modified cannot prove that this operation reached Frappe.
        return False
    if doctype == "Quotation":
        for field in ("quotation_to", "company", "party_name", "transaction_date", "currency"):
            if actual.get(field) != expected.get(field):
                return False
        if actual.get("valid_till") != expected.get("valid_till"):
            return False
    else:
        # Optional Purchase Order fields may be default-filled by ERPNext
        # (currency, uom, rate, schedule_date); only requested values are asserted.
        for field in ("company", "supplier", "transaction_date", "schedule_date", "currency"):
            if field in expected and actual.get(field) != expected.get(field):
                return False
    expected_items = expected.get("items")
    actual_items = actual.get("items")
    if not isinstance(expected_items, list) or not isinstance(actual_items, list) or len(expected_items) != len(actual_items):
        return False
    for expected_item, actual_item in zip(expected_items, actual_items):
        if not isinstance(actual_item, dict):
            return False
        if actual_item.get("item_code") != expected_item.get("item_code"):
            return False
        if not _decimal_equal(actual_item.get("qty"), expected_item.get("qty")):
            return False
        if doctype == "Quotation":
            if actual_item.get("uom") != expected_item.get("uom"):
                return False
            if not _decimal_equal(actual_item.get("rate"), expected_item.get("rate")):
                return False
        else:
            if "uom" in expected_item and actual_item.get("uom") != expected_item.get("uom"):
                return False
            if "rate" in expected_item and not _decimal_equal(actual_item.get("rate"), expected_item.get("rate")):
                return False
    return True


def _succeed(operation: ErpNextDraftOperation, record: dict[str, Any], *, doctype: str, subject: str) -> None:
    with transaction.atomic():
        current = ErpNextDraftOperation.objects.select_for_update().get(pk=operation.pk)
        if current.status in {ErpNextDraftOperation.Status.SUCCEEDED, ErpNextDraftOperation.Status.CONFLICT}:
            operation.refresh_from_db()
            return
        if record.get("doctype") != doctype or record.get("data", {}).get("docstatus") != 0:
            raise ErpNextError("invalid_response", f"ERPNext {subject}回读未确认草稿状态")
        if not _matches_reserved_payload(current, record, doctype=doctype):
            raise ErpNextError("invalid_response", f"ERPNext {subject}回读与预留内容不匹配")
        data = record["data"]
        if data.get("name") != current.remote_name or record.get("external_ref", {}).get("instance_id") != current.instance_id:
            raise ErpNextError("invalid_response", f"ERPNext {subject}回读标识不匹配")
        modified = data.get("modified")
        if not _valid_modified(modified) or record.get("external_ref", {}).get("modified") != modified:
            raise ErpNextError("invalid_response", f"ERPNext {subject}版本格式无效")
        current.remote_modified = modified
        current.receipt = record
        current.result_ref = record["external_ref"]
        current.status = ErpNextDraftOperation.Status.SUCCEEDED
        current.error_code = ""
        current.save(update_fields=["remote_modified", "receipt", "result_ref", "status", "error_code", "updated_at"])
        EventLog.objects.create(
            task=current.workflow,
            event_type="erpnext_draft_succeeded",
            actor=current.source,
            payload_summary={
                "operation_id": current.id,
                "action": current.action,
                "instance_id": current.instance_id,
                "payload_sha256": current.payload_sha256,
                "remote_name": current.remote_name,
                "remote_modified": current.remote_modified,
            },
        )
        operation.refresh_from_db()


def create_quotation_draft(
    client: ErpNextClient,
    *,
    idempotency_key: Any,
    payload: Any,
    workflow_id: Any = None,
) -> DraftOperationResult:
    key = _validate_key(idempotency_key)
    try:
        normalized = normalize_quotation_payload(payload)
    except ValueError:
        raise DraftOperationError("invalid_arguments", "报价草稿内容无效", 422) from None
    workflow = _workflow(workflow_id)
    operation, created = _reserve_create(
        client, key, normalized, workflow,
        doctype="Quotation", payload_prefix={"quotation_to": "Customer"},
    )
    if not created:
        operation.refresh_from_db()
        _upgrade_legacy_reserved(operation)
        remote_current, remote_error = _current_remote(client, operation, doctype="Quotation")
        if remote_current is not None and operation.status == ErpNextDraftOperation.Status.OUTCOME_UNKNOWN:
            if _matches_reserved_payload(operation, remote_current, doctype="Quotation"):
                _succeed(operation, remote_current, doctype="Quotation", subject="报价")
                operation.refresh_from_db()
        return DraftOperationResult(operation, False, remote_current, remote_error)

    try:
        created_record = client.create_quotation_draft(normalized)
        name = created_record["data"]["name"]
        operation.remote_name = name
        operation.save(update_fields=["remote_name", "updated_at"])
    except ErpNextError as exc:
        _mark_unknown(operation, exc.code, remote_name=getattr(exc, "remote_name", ""))
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable")
        return DraftOperationResult(operation, True, None, operation.error_code)

    try:
        current = client.get_quotation_draft(operation.remote_name)
        _succeed(operation, current, doctype="Quotation", subject="报价")
        return DraftOperationResult(operation, True, current)
    except ErpNextError as exc:
        _mark_unknown(operation, exc.code, remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable", remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)


def update_quotation_draft(
    client: ErpNextClient,
    *,
    target_operation_id: Any,
    idempotency_key: Any,
    expected_modified: Any,
    payload: Any,
    workflow_id: Any = None,
) -> DraftOperationResult:
    key = _validate_key(idempotency_key)
    try:
        normalized = normalize_quotation_payload(payload)
    except ValueError:
        raise DraftOperationError("invalid_arguments", "报价草稿内容无效", 422) from None
    if not _valid_modified(expected_modified):
        raise DraftOperationError("invalid_arguments", "预期版本格式无效", 422)
    operation, created = _reserve_update(
        client,
        key=key,
        normalized=normalized,
        target_id=target_operation_id,
        expected_modified=expected_modified,
        workflow_id=workflow_id,
        doctype="Quotation",
        payload_prefix={"quotation_to": "Customer"},
    )
    if not created:
        operation.refresh_from_db()
        _upgrade_legacy_reserved(operation)
        remote_current, remote_error = _current_remote(client, operation, doctype="Quotation")
        if remote_current is not None and operation.status == ErpNextDraftOperation.Status.OUTCOME_UNKNOWN:
            if _matches_reserved_payload(operation, remote_current, doctype="Quotation"):
                _succeed(operation, remote_current, doctype="Quotation", subject="报价")
                operation.refresh_from_db()
        return DraftOperationResult(operation, False, remote_current, remote_error)

    try:
        client.update_quotation_draft(
            operation.remote_name,
            normalized,
            expected_modified=operation.expected_modified,
        )
    except ErpNextError as exc:
        if exc.code == "conflict":
            _mark_conflict(operation)
            if operation.status != ErpNextDraftOperation.Status.CONFLICT:
                return DraftOperationResult(operation, True, None, operation.error_code)
            remote_current, _remote_error = _current_remote(client, operation, doctype="Quotation")
            return DraftOperationResult(operation, True, remote_current, "conflict")
        _mark_unknown(operation, exc.code, remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable", remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)

    try:
        current = client.get_quotation_draft(operation.remote_name)
        _succeed(operation, current, doctype="Quotation", subject="报价")
        return DraftOperationResult(operation, True, current)
    except ErpNextError as exc:
        _mark_unknown(operation, exc.code, remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable", remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)


def get_quotation_draft_operation(client: ErpNextClient | None, operation_id: str) -> DraftOperationResult:
    try:
        operation = ErpNextDraftOperation.objects.get(pk=operation_id, doctype="Quotation")
    except ErpNextDraftOperation.DoesNotExist:
        raise DraftOperationError("not_found", "草稿操作不存在", 404) from None
    _upgrade_legacy_reserved(operation)
    if client is None:
        return DraftOperationResult(operation, False, None, "not_configured")
    remote_current, remote_error = _current_remote(client, operation, doctype="Quotation")
    if remote_current is not None and operation.status == ErpNextDraftOperation.Status.OUTCOME_UNKNOWN:
        if _matches_reserved_payload(operation, remote_current, doctype="Quotation"):
            _succeed(operation, remote_current, doctype="Quotation", subject="报价")
            operation.refresh_from_db()
    return DraftOperationResult(operation, False, remote_current, remote_error)


def create_purchase_order_draft(
    client: ErpNextClient,
    *,
    idempotency_key: Any,
    payload: Any,
    workflow_id: Any = None,
) -> DraftOperationResult:
    key = _validate_key(idempotency_key)
    try:
        normalized = normalize_purchase_order_payload(payload)
    except ValueError:
        raise DraftOperationError("invalid_arguments", "采购订单草稿内容无效", 422) from None
    workflow = _workflow(workflow_id)
    operation, created = _reserve_create(
        client, key, normalized, workflow,
        doctype="Purchase Order", payload_prefix={},
    )
    if not created:
        operation.refresh_from_db()
        _upgrade_legacy_reserved(operation)
        remote_current, remote_error = _current_remote(client, operation, doctype="Purchase Order")
        if remote_current is not None and operation.status == ErpNextDraftOperation.Status.OUTCOME_UNKNOWN:
            if _matches_reserved_payload(operation, remote_current, doctype="Purchase Order"):
                _succeed(operation, remote_current, doctype="Purchase Order", subject="采购订单")
                operation.refresh_from_db()
        return DraftOperationResult(operation, False, remote_current, remote_error)

    try:
        created_record = client.create_purchase_order_draft(normalized)
        name = created_record["data"]["name"]
        operation.remote_name = name
        operation.save(update_fields=["remote_name", "updated_at"])
    except ErpNextError as exc:
        _mark_unknown(operation, exc.code, remote_name=getattr(exc, "remote_name", ""))
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable")
        return DraftOperationResult(operation, True, None, operation.error_code)

    try:
        current = client.get_purchase_order_draft(operation.remote_name)
        _succeed(operation, current, doctype="Purchase Order", subject="采购订单")
        return DraftOperationResult(operation, True, current)
    except ErpNextError as exc:
        _mark_unknown(operation, exc.code, remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable", remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)


def update_purchase_order_draft(
    client: ErpNextClient,
    *,
    target_operation_id: Any,
    idempotency_key: Any,
    expected_modified: Any,
    payload: Any,
    workflow_id: Any = None,
) -> DraftOperationResult:
    key = _validate_key(idempotency_key)
    try:
        normalized = normalize_purchase_order_payload(payload)
    except ValueError:
        raise DraftOperationError("invalid_arguments", "采购订单草稿内容无效", 422) from None
    if not _valid_modified(expected_modified):
        raise DraftOperationError("invalid_arguments", "预期版本格式无效", 422)
    operation, created = _reserve_update(
        client,
        key=key,
        normalized=normalized,
        target_id=target_operation_id,
        expected_modified=expected_modified,
        workflow_id=workflow_id,
        doctype="Purchase Order",
        payload_prefix={},
    )
    if not created:
        operation.refresh_from_db()
        _upgrade_legacy_reserved(operation)
        remote_current, remote_error = _current_remote(client, operation, doctype="Purchase Order")
        if remote_current is not None and operation.status == ErpNextDraftOperation.Status.OUTCOME_UNKNOWN:
            if _matches_reserved_payload(operation, remote_current, doctype="Purchase Order"):
                _succeed(operation, remote_current, doctype="Purchase Order", subject="采购订单")
                operation.refresh_from_db()
        return DraftOperationResult(operation, False, remote_current, remote_error)

    try:
        client.update_purchase_order_draft(
            operation.remote_name,
            normalized,
            expected_modified=operation.expected_modified,
        )
    except ErpNextError as exc:
        if exc.code == "conflict":
            _mark_conflict(operation)
            if operation.status != ErpNextDraftOperation.Status.CONFLICT:
                return DraftOperationResult(operation, True, None, operation.error_code)
            remote_current, _remote_error = _current_remote(client, operation, doctype="Purchase Order")
            return DraftOperationResult(operation, True, remote_current, "conflict")
        _mark_unknown(operation, exc.code, remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable", remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)

    try:
        current = client.get_purchase_order_draft(operation.remote_name)
        _succeed(operation, current, doctype="Purchase Order", subject="采购订单")
        return DraftOperationResult(operation, True, current)
    except ErpNextError as exc:
        _mark_unknown(operation, exc.code, remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)
    except Exception:
        _mark_unknown(operation, "unavailable", remote_name=operation.remote_name)
        return DraftOperationResult(operation, True, None, operation.error_code)


def get_purchase_order_draft_operation(client: ErpNextClient | None, operation_id: str) -> DraftOperationResult:
    try:
        operation = ErpNextDraftOperation.objects.get(pk=operation_id, doctype="Purchase Order")
    except ErpNextDraftOperation.DoesNotExist:
        raise DraftOperationError("not_found", "草稿操作不存在", 404) from None
    _upgrade_legacy_reserved(operation)
    if client is None:
        return DraftOperationResult(operation, False, None, "not_configured")
    remote_current, remote_error = _current_remote(client, operation, doctype="Purchase Order")
    if remote_current is not None and operation.status == ErpNextDraftOperation.Status.OUTCOME_UNKNOWN:
        if _matches_reserved_payload(operation, remote_current, doctype="Purchase Order"):
            _succeed(operation, remote_current, doctype="Purchase Order", subject="采购订单")
            operation.refresh_from_db()
    return DraftOperationResult(operation, False, remote_current, remote_error)
