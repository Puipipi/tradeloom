from __future__ import annotations

import json
import logging
import threading
import uuid
from copy import deepcopy
from unittest.mock import patch

from django.core.exceptions import ValidationError
from django.db import close_old_connections, connection
from django.db.models.signals import pre_save
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from workbench.erpnext.client import ErpNextClient, ErpNextConfig, ErpNextError
from workbench.models import ErpNextDraftOperation, EventLog, Task, WorkflowTask


def quotation_input(**overrides):
    value = {
        "company": "Example Company",
        "party_name": "CUST-001",
        "transaction_date": "2026-10-21",
        "valid_till": "2026-11-20",
        "currency": "USD",
        "items": [
            {"item_code": "ITEM-001", "qty": "2", "rate": "10.25", "uom": "Nos"},
        ],
    }
    value.update(overrides)
    return value


def quote_record(*, modified="2026-10-21 12:00:00.000000", grand_total=20.5):
    data = {
        "name": "QTN-2026-00001",
        "modified": modified,
        "docstatus": 0,
        "company": "Example Company",
        "quotation_to": "Customer",
        "party_name": "CUST-001",
        "transaction_date": "2026-10-21",
        "valid_till": "2026-11-20",
        "currency": "USD",
        "grand_total": grand_total,
        "items": [
            {"item_code": "ITEM-001", "qty": 2, "rate": 10.25, "uom": "Nos", "amount": grand_total},
        ],
    }
    return {
        "doctype": "Quotation",
        "data": data,
        "external_ref": {
            "system": "erpnext", "instance_id": "test-instance", "doctype": "Quotation",
            "name": data["name"], "modified": modified,
        },
    }


def force_legacy_reserved_row(operation):
    # Simulate a row written by the earlier release; production QuerySet.update
    # intentionally rejects application-level status rewrites.
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE workbench_erpnextdraftoperation "
            "SET status = 'reserved', remote_name = '', remote_modified = '', "
            "receipt = NULL, result_ref = '{}'::jsonb WHERE id = %s",
            [operation.pk],
        )
        assert cursor.rowcount == 1


class DraftClient:
    instance_id = "test-instance"

    def __init__(self):
        self.create_calls = []
        self.update_calls = []
        self.read_calls = []
        self.create_result = quote_record()
        self.read_result = quote_record()
        self.create_error = None
        self.read_error = None
        self.on_create = None
        self.update_error = None
        self.update_result = quote_record(modified="2026-10-21 12:30:00.000000")
        self.on_update = None

    def create_quotation_draft(self, payload):
        self.create_calls.append(deepcopy(payload))
        if self.on_create:
            self.on_create()
        if self.create_error:
            raise self.create_error
        self.read_result = deepcopy(self.create_result)
        return deepcopy(self.create_result)

    def get_quotation_draft(self, name):
        self.read_calls.append(name)
        if self.read_error:
            raise self.read_error
        return deepcopy(self.read_result)

    def update_quotation_draft(self, name, payload, *, expected_modified):
        self.update_calls.append((name, deepcopy(payload), expected_modified))
        if self.on_update:
            self.on_update()
        if self.update_error:
            raise self.update_error
        self.update_result = quote_record(modified="2026-10-21 12:30:00.000000")
        self.update_result["data"].update({
            key: deepcopy(payload[key])
            for key in ("company", "party_name", "transaction_date", "valid_till", "currency", "items")
            if key in payload
        })
        self.read_result = deepcopy(self.update_result)
        return deepcopy(self.update_result)


@override_settings(
    TRADELOOM_ERPNEXT_BASE_URL="https://erp.example.test",
    TRADELOOM_ERPNEXT_INSTANCE_ID="test-instance",
    TRADELOOM_ERPNEXT_API_KEY="test-key",
    TRADELOOM_ERPNEXT_API_SECRET="test-secret",
)
class ErpNextDraftApiTests(TestCase):
    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="草稿测试批次", mode="demo", status="active",
            created_at=now, updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=self.batch, user_goal="准备报价", task_type="prepare_product_data",
        )
        self.url = "/api/erpnext/quotation-drafts"
        self.client_stub = DraftClient()

    def post(self, *, key="quotation-create-1", payload=None, workflow_id=None, extra=None):
        body = {"idempotency_key": key, "payload": payload or quotation_input()}
        if workflow_id is not None:
            body["workflow_id"] = workflow_id
        if extra:
            body.update(extra)
        with patch("workbench.erpnext.api._client_from_settings", return_value=self.client_stub):
            return self.client.post(self.url, data=json.dumps(body), content_type="application/json")

    def put(self, target_operation_id, *, key="quotation-update-1", expected_modified="2026-10-21 12:00:00.000000", payload=None, workflow_id=None, extra=None):
        body = {
            "idempotency_key": key,
            "expected_modified": expected_modified,
            "payload": payload or quotation_input(party_name="CUST-002"),
        }
        if workflow_id is not None:
            body["workflow_id"] = workflow_id
        if extra:
            body.update(extra)
        with patch("workbench.erpnext.api._client_from_settings", return_value=self.client_stub):
            return self.client.put(
                f"{self.url}/{target_operation_id}",
                data=json.dumps(body), content_type="application/json",
            )

    def test_create_reserves_operation_before_network_and_returns_fixed_draft_receipt(self):
        def assert_reserved_before_remote_call():
            operation = ErpNextDraftOperation.objects.get(idempotency_key="quotation-create-1")
            self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
            self.assertEqual(operation.action, ErpNextDraftOperation.Action.CREATE)

        self.client_stub.on_create = assert_reserved_before_remote_call
        response = self.post(workflow_id=self.workflow.id)

        self.assertEqual(response.status_code, 201)
        payload = response.json()
        operation = ErpNextDraftOperation.objects.get(pk=payload["operation_id"])
        self.assertRegex(operation.id, r"^[0-9a-f]{32}$")
        self.assertEqual(operation.workflow_id, self.workflow.id)
        self.assertEqual(operation.source, ErpNextDraftOperation.Source.LOCAL_WORKBENCH)
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.SUCCEEDED)
        self.assertEqual(operation.remote_name, "QTN-2026-00001")
        self.assertEqual(operation.receipt["data"]["docstatus"], 0)
        self.assertEqual(operation.receipt["data"]["quotation_to"], "Customer")
        self.assertEqual(payload["remote_current"]["data"]["grand_total"], 20.5)
        self.assertNotIn("quotation_to", self.client_stub.create_calls[0])
        self.assertNotIn("docstatus", self.client_stub.create_calls[0])
        self.assertEqual(self.client_stub.read_calls, ["QTN-2026-00001"])
        self.assertEqual(
            EventLog.objects.filter(task=self.workflow, event_type="erpnext_draft_succeeded").count(), 1,
        )

    def test_same_key_and_fingerprint_replays_immutable_receipt_without_second_create(self):
        first = self.post()
        self.assertEqual(first.status_code, 201)
        operation_id = first.json()["operation_id"]
        original_receipt = deepcopy(ErpNextDraftOperation.objects.get(pk=operation_id).receipt)

        second = self.post()

        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["operation_id"], operation_id)
        self.assertEqual(len(self.client_stub.create_calls), 1)
        operation = ErpNextDraftOperation.objects.get(pk=operation_id)
        self.assertEqual(operation.receipt, original_receipt)

    def test_same_key_with_different_normalized_payload_conflicts_without_network_io(self):
        self.assertEqual(self.post().status_code, 201)
        changed = quotation_input(party_name="CUST-002")

        response = self.post(payload=changed)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error_code"], "idempotency_conflict")
        self.assertEqual(len(self.client_stub.create_calls), 1)
        self.assertEqual(ErpNextDraftOperation.objects.count(), 1)

    def test_equivalent_decimal_spellings_share_the_same_fingerprint(self):
        first = self.post()
        normalized = quotation_input(items=[{
            "item_code": "ITEM-001", "qty": "2.000", "rate": "10.2500", "uom": "Nos",
        }])

        second = self.post(payload=normalized)

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["operation_id"], second.json()["operation_id"])
        self.assertEqual(len(self.client_stub.create_calls), 1)

    def test_nonfinite_numbers_and_unlisted_fields_are_rejected_before_reservation(self):
        for value in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(value=value):
                payload = quotation_input(items=[{
                    "item_code": "ITEM-001", "qty": value, "rate": "10", "uom": "Nos",
                }])
                response = self.post(key=f"bad-{value}", payload=payload)
                self.assertEqual(response.status_code, 422)

        response = self.post(key="bad-tax", payload=quotation_input(tax_category="Taxable"))

        self.assertEqual(response.status_code, 422)
        self.assertEqual(ErpNextDraftOperation.objects.count(), 0)
        self.assertEqual(self.client_stub.create_calls, [])

    def test_external_failure_is_unknown_and_replay_never_reissues_create(self):
        self.client_stub.create_error = ErpNextError("unavailable", "secret raw remote response")

        first = self.post()
        second = self.post()

        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertEqual(first.json()["status"], "outcome_unknown")
        self.assertEqual(second.json()["operation_id"], first.json()["operation_id"])
        self.assertEqual(len(self.client_stub.create_calls), 1)
        self.assertEqual(self.client_stub.read_calls, [])
        operation = ErpNextDraftOperation.objects.get(pk=first.json()["operation_id"])
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.remote_name, "")
        self.assertNotIn("secret raw remote response", first.content.decode())

    def test_forbidden_create_is_unknown_and_same_key_replay_never_reissues_create(self):
        self.client_stub.create_error = ErpNextError("forbidden", "private ERPNext permission response")

        first = self.post(key="forbidden-create-once")
        second = self.post(key="forbidden-create-once")

        self.assertEqual(first.status_code, 202)
        self.assertEqual(second.status_code, 202)
        self.assertEqual(first.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(second.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(second.json()["operation_id"], first.json()["operation_id"])
        self.assertEqual(len(self.client_stub.create_calls), 1)
        self.assertEqual(self.client_stub.read_calls, [])
        operation = ErpNextDraftOperation.objects.get(pk=first.json()["operation_id"])
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.error_code, "forbidden")
        self.assertEqual(operation.remote_name, "")
        self.assertNotIn("private ERPNext permission response", first.content.decode())
        self.assertNotIn("private ERPNext permission response", second.content.decode())

    def test_readback_failure_keeps_known_remote_name_and_never_changes_success_receipt(self):
        self.client_stub.read_error = ErpNextError("unavailable", "raw private response")

        response = self.post()

        self.assertEqual(response.status_code, 202)
        operation = ErpNextDraftOperation.objects.get(pk=response.json()["operation_id"])
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.remote_name, "QTN-2026-00001")
        self.assertIsNone(operation.receipt)
        self.assertNotIn("raw private response", response.content.decode())

        self.client_stub.read_error = None
        self.client_stub.read_result = quote_record()
        with patch("workbench.erpnext.api._client_from_settings", return_value=self.client_stub):
            reconciled = self.client.get(f"{self.url}/{operation.id}")

        self.assertEqual(reconciled.status_code, 200)
        self.assertEqual(reconciled.json()["status"], ErpNextDraftOperation.Status.SUCCEEDED)
        self.assertEqual(len(self.client_stub.create_calls), 1)
        operation.refresh_from_db()
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.SUCCEEDED)
        self.assertIsNotNone(operation.receipt)

    def test_invalid_remote_modified_never_marks_create_succeeded(self):
        malformed = quote_record(modified="2026-13-40 12:00:00.000000")
        self.client_stub.create_result = malformed
        self.client_stub.read_result = malformed

        response = self.post()

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        operation = ErpNextDraftOperation.objects.get(pk=response.json()["operation_id"])
        self.assertEqual(operation.remote_name, "QTN-2026-00001")
        self.assertEqual(operation.remote_modified, "")
        self.assertIsNone(operation.receipt)

    def test_success_receipt_preserves_remote_modified_exactly(self):
        modified = "2026-10-21 12:00:00.123456"
        self.client_stub.create_result = quote_record(modified=modified)
        self.client_stub.read_result = quote_record(modified=modified)

        response = self.post()

        self.assertEqual(response.status_code, 201)
        operation = ErpNextDraftOperation.objects.get(pk=response.json()["operation_id"])
        self.assertEqual(operation.remote_modified, modified)
        self.assertEqual(operation.receipt["external_ref"]["modified"], modified)

    def test_legacy_reserved_operation_is_unknown_and_never_reissued(self):
        first = self.post(key="legacy-reserved")
        operation = ErpNextDraftOperation.objects.get(pk=first.json()["operation_id"])
        force_legacy_reserved_row(operation)
        self.client_stub.create_calls.clear()

        replay = self.post(key="legacy-reserved")

        operation.refresh_from_db()
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.remote_name, "")
        self.assertEqual(self.client_stub.create_calls, [])

    def test_unknown_202_is_not_reported_as_success(self):
        self.client_stub.create_error = ErpNextError("unavailable", "private transport detail")

        response = self.post()

        self.assertEqual(response.status_code, 202)
        self.assertTrue(response.json()["ok"])
        self.assertNotEqual(response.json()["status"], ErpNextDraftOperation.Status.SUCCEEDED)

    def test_get_keeps_historical_receipt_separate_from_fresh_remote_readback(self):
        created = self.post()
        operation_id = created.json()["operation_id"]
        frozen_receipt = deepcopy(ErpNextDraftOperation.objects.get(pk=operation_id).receipt)
        self.client_stub.read_result = quote_record(modified="2026-10-22 08:00:00.000000", grand_total=23.0)

        with patch("workbench.erpnext.api._client_from_settings", return_value=self.client_stub):
            response = self.client.get(f"{self.url}/{operation_id}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["receipt"], frozen_receipt)
        self.assertEqual(response.json()["remote_current"]["data"]["grand_total"], 23.0)
        self.assertNotEqual(response.json()["remote_current"]["data"]["modified"], frozen_receipt["data"]["modified"])
        self.assertEqual(ErpNextDraftOperation.objects.get(pk=operation_id).receipt, frozen_receipt)

    def test_client_role_or_actor_fields_cannot_authorize_or_enter_operation(self):
        response = self.post(extra={"role": "center", "actor": "center"})

        self.assertEqual(response.status_code, 422)
        self.assertEqual(ErpNextDraftOperation.objects.count(), 0)
        self.assertEqual(self.client_stub.create_calls, [])

    def test_browser_write_requires_csrf_cookie_and_header(self):
        csrf_client = Client(enforce_csrf_checks=True)
        with patch("workbench.erpnext.api._client_from_settings", return_value=self.client_stub):
            denied = csrf_client.post(
                self.url,
                data=json.dumps({"idempotency_key": "csrf-test", "payload": quotation_input()}),
                content_type="application/json",
            )
            self.assertEqual(denied.status_code, 403)
            self.assertEqual(ErpNextDraftOperation.objects.count(), 0)

            csrf_client.get("/")
            token = csrf_client.cookies["csrftoken"].value
            allowed = csrf_client.post(
                self.url,
                data=json.dumps({"idempotency_key": "csrf-test", "payload": quotation_input()}),
                content_type="application/json",
                HTTP_X_CSRFTOKEN=token,
            )

        self.assertEqual(allowed.status_code, 201)
        self.assertEqual(len(self.client_stub.create_calls), 1)

    def test_operation_request_and_success_receipt_cannot_be_rewritten(self):
        response = self.post()
        operation = ErpNextDraftOperation.objects.get(pk=response.json()["operation_id"])
        operation.request_payload = quotation_input(party_name="CHANGED")
        with self.assertRaises(ValidationError):
            operation.save()

        operation.refresh_from_db()
        original_receipt = deepcopy(operation.receipt)
        operation.receipt["data"]["grand_total"] = 0
        with self.assertRaises(ValidationError):
            operation.save()
        operation.refresh_from_db()
        self.assertEqual(operation.receipt, original_receipt)
        with self.assertRaises(ValidationError):
            ErpNextDraftOperation.objects.filter(pk=operation.pk).update(status="outcome_unknown")
        with self.assertRaises(ValidationError):
            ErpNextDraftOperation.objects.filter(pk=operation.pk).update(receipt={})

    def test_update_uses_new_immutable_operation_and_preserves_create_receipt(self):
        created = self.post(workflow_id=self.workflow.id)
        target_id = created.json()["operation_id"]
        target = ErpNextDraftOperation.objects.get(pk=target_id)
        original_receipt = deepcopy(target.receipt)

        def assert_unknown_before_remote_update():
            update = ErpNextDraftOperation.objects.get(idempotency_key="quotation-update-1")
            self.assertEqual(update.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)

        self.client_stub.on_update = assert_unknown_before_remote_update
        response = self.put(target_id, workflow_id=self.workflow.id)

        self.assertEqual(response.status_code, 200)
        result = response.json()
        update = ErpNextDraftOperation.objects.get(pk=result["operation_id"])
        target.refresh_from_db()
        self.assertNotEqual(update.id, target.id)
        self.assertEqual(update.action, ErpNextDraftOperation.Action.UPDATE)
        self.assertEqual(update.target_operation_id, target.id)
        self.assertEqual(update.expected_modified, "2026-10-21 12:00:00.000000")
        self.assertEqual(update.status, ErpNextDraftOperation.Status.SUCCEEDED)
        self.assertEqual(self.client_stub.update_calls[0][0], target.remote_name)
        self.assertEqual(self.client_stub.update_calls[0][2], update.expected_modified)
        self.assertEqual(target.receipt, original_receipt)
        self.assertEqual(result["receipt"]["data"]["party_name"], "CUST-002")
        self.assertEqual(len(self.client_stub.create_calls), 1)

    def test_same_update_key_replays_without_second_put_and_changed_fingerprint_conflicts(self):
        target = self.post().json()["operation_id"]
        first = self.put(target)
        second = self.put(target)
        conflicting = self.put(target, payload=quotation_input(party_name="CUST-003"))

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["operation_id"], first.json()["operation_id"])
        self.assertEqual(conflicting.status_code, 409)
        self.assertEqual(conflicting.json()["error_code"], "idempotency_conflict")
        self.assertEqual(len(self.client_stub.update_calls), 1)

    def test_update_requires_successful_same_instance_target_and_matching_workflow(self):
        target = self.post().json()["operation_id"]
        other_workflow = WorkflowTask.objects.create(
            batch=self.batch, user_goal="另一个流程", task_type="prepare_product_data",
        )
        mismatch = self.put(target, workflow_id=other_workflow.id)
        self.assertEqual(mismatch.status_code, 409)
        self.assertEqual(self.client_stub.update_calls, [])

        unknown = ErpNextDraftOperation.objects.create(
            instance_id="test-instance", idempotency_key="unknown-target",
            action=ErpNextDraftOperation.Action.CREATE, fingerprint="a" * 64,
            payload_sha256="b" * 64, request_payload={}, doctype="Quotation",
            source=ErpNextDraftOperation.Source.LOCAL_WORKBENCH,
            status=ErpNextDraftOperation.Status.OUTCOME_UNKNOWN,
        )
        rejected = self.put(unknown.id, key="update-unknown")
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(self.client_stub.update_calls, [])

    def test_atomic_version_conflict_is_terminal_and_does_not_resend(self):
        target = self.post().json()["operation_id"]
        self.client_stub.update_error = ErpNextError("conflict", "remote timestamp mismatch")

        first = self.put(target)
        replay = self.put(target)

        self.assertEqual(first.status_code, 409)
        self.assertEqual(first.json()["status"], ErpNextDraftOperation.Status.CONFLICT)
        self.assertEqual(first.json()["error_code"], "conflict")
        self.assertNotIn("remote timestamp mismatch", first.content.decode())
        self.assertEqual(replay.json()["operation_id"], first.json()["operation_id"])
        self.assertEqual(len(self.client_stub.update_calls), 1)

    def test_update_rejects_calendar_invalid_expected_modified_before_reserving(self):
        target = self.post().json()["operation_id"]

        response = self.put(target, expected_modified="2026-99-88 12:00:00.000000")

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "invalid_arguments")
        self.assertEqual(self.client_stub.update_calls, [])
        self.assertFalse(ErpNextDraftOperation.objects.filter(idempotency_key="quotation-update-1").exists())

    def test_update_transport_failure_is_unknown_and_only_reconciles_by_read(self):
        target = self.post().json()["operation_id"]
        self.client_stub.update_error = ErpNextError("unavailable", "raw remote content")

        # The requested values already match the create receipt; unchanged
        # modified still cannot prove that the timed-out PUT reached Frappe.
        first = self.put(target, payload=quotation_input())
        replay = self.put(target, payload=quotation_input())

        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(replay.json()["operation_id"], first.json()["operation_id"])
        self.assertEqual(len(self.client_stub.update_calls), 1)
        self.assertNotIn("raw remote content", first.content.decode())
        self.assertEqual(replay.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)

    def test_client_update_uses_fixed_quotation_path_and_atomic_modified_payload(self):
        calls = []

        def transport(method, url, headers, body, _timeout):
            calls.append((method, url, headers, json.loads(body)))
            updated = quote_record(modified="2026-10-21 12:30:00.000000")
            updated["data"]["name"] = "QTN / 1"
            updated["external_ref"]["name"] = "QTN / 1"
            return 200, {"Content-Type": "application/json"}, json.dumps(updated).encode()

        client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key-secret", "api-secret"),
            transport=transport,
        )
        client.update_quotation_draft(
            "QTN / 1", quotation_input(party_name="CUST-002"),
            expected_modified="2026-10-21 12:00:00.000000",
        )

        method, url, _headers, body = calls[0]
        self.assertEqual(method, "PUT")
        self.assertEqual(url, "https://erp.example.test/api/resource/Quotation/QTN%20%2F%201")
        self.assertEqual(body["modified"], "2026-10-21 12:00:00.000000")
        self.assertEqual(body["docstatus"], 0)
        self.assertEqual(body["quotation_to"], "Customer")

    def test_frappe_timestamp_mismatch_http_417_is_a_stable_conflict(self):
        client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key", "secret"),
            transport=lambda *_args: (
                417, {"Content-Type": "application/json"},
                b'{"exc_type":"TimestampMismatchError","exception":"private Frappe traceback"}',
            ),
        )

        with self.assertRaises(ErpNextError) as raised:
            client.update_quotation_draft(
                "QTN-1", quotation_input(), expected_modified="2026-10-21 12:00:00.000000",
            )

        self.assertEqual(raised.exception.code, "conflict")
        self.assertNotIn("private Frappe traceback", str(raised.exception))

        validation_client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key", "secret"),
            transport=lambda *_args: (417, {"Content-Type": "application/json"}, b'{"exc_type":"ValidationError"}'),
        )
        with self.assertRaises(ErpNextError) as validation_error:
            validation_client.update_quotation_draft(
                "QTN-1", quotation_input(), expected_modified="2026-10-21 12:00:00.000000",
            )
        self.assertEqual(validation_error.exception.code, "http_error")

    def test_forbidden_create_logs_only_allowlisted_frappe_error_summary(self):
        secret = "SYNTHETIC_SECRET_403_PERMISSION"
        client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key", "secret"),
            transport=lambda *_args: (
                403,
                {"Content-Type": "application/json"},
                json.dumps({
                    "exc_type": "PermissionError",
                    "exception": f"{secret} traceback",
                    "_server_messages": f"{secret} message",
                }).encode(),
            ),
        )

        with self.assertLogs("workbench.erpnext.client", level="WARNING") as captured:
            with self.assertRaises(ErpNextError) as raised:
                client.create_quotation_draft(quotation_input())

        self.assertEqual(raised.exception.code, "forbidden")
        self.assertEqual(str(raised.exception), "ERPNext 不允许此操作")
        output = "\n".join(captured.output)
        self.assertIn("status=403", output)
        self.assertIn("method=POST", output)
        self.assertIn("response_format=json", output)
        self.assertIn("exception_type=PermissionError", output)
        self.assertNotIn(secret, output)
        self.assertNotIn("traceback", output)
        self.assertNotIn("_server_messages", output)
        self.assertNotIn("erp.example.test", output)

    def test_forbidden_arbitrary_exception_type_is_logged_as_unknown(self):
        secret = "SYNTHETIC_SECRET_403_UNKNOWN"
        client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key", "secret"),
            transport=lambda *_args: (
                403,
                {"Content-Type": "application/json"},
                json.dumps({
                    "exc_type": f"FakePermissionError:{secret}",
                    "exception": secret,
                }).encode(),
            ),
        )

        with self.assertLogs("workbench.erpnext.client", level="WARNING") as captured:
            with self.assertRaises(ErpNextError) as raised:
                client.create_quotation_draft(quotation_input())

        output = "\n".join(captured.output)
        self.assertEqual(raised.exception.code, "forbidden")
        self.assertIn("exception_type=unknown", output)
        self.assertNotIn(secret, output)
        self.assertNotIn("FakePermissionError", output)

    def test_forbidden_html_response_logs_fixed_summary(self):
        secret = "SYNTHETIC_SECRET_403_HTML"
        client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key", "secret"),
            transport=lambda *_args: (
                403,
                {"Content-Type": "text/html; charset=utf-8"},
                f"<html>{secret}</html>".encode(),
            ),
        )

        with self.assertLogs("workbench.erpnext.client", level="WARNING") as captured:
            with self.assertRaises(ErpNextError) as raised:
                client.create_quotation_draft(quotation_input())

        output = "\n".join(captured.output)
        self.assertEqual(raised.exception.code, "forbidden")
        self.assertIn("status=403", output)
        self.assertIn("method=POST", output)
        self.assertIn("response_format=html", output)
        self.assertIn("exception_type=unknown", output)
        self.assertNotIn(secret, output)
        self.assertNotIn("text/html", output)

    def test_fixed_client_posts_only_quotation_resource_and_hides_credentials(self):
        calls = []

        def transport(method, url, headers, body, _timeout):
            calls.append((method, url, headers, body))
            return 200, {"Content-Type": "application/json"}, json.dumps(quote_record()).encode()

        client = ErpNextClient(
            ErpNextConfig("https://erp.example.test", "test-instance", "key-secret", "api-secret"),
            transport=transport,
        )
        created = client.create_quotation_draft(quotation_input())

        self.assertEqual(created["doctype"], "Quotation")
        self.assertEqual(calls[0][0], "POST")
        self.assertEqual(calls[0][1], "https://erp.example.test/api/resource/Quotation")
        self.assertNotIn("secret", calls[0][1])
        self.assertEqual(json.loads(calls[0][3])["quotation_to"], "Customer")
        self.assertNotIn("docstatus", json.loads(calls[0][3]))
        self.assertNotIn("key-secret", repr(client))
        self.assertNotIn("api-secret", repr(client))


class _BlockingDraftClient(DraftClient):
    def __init__(self):
        super().__init__()
        self.read_result = None
        self.create_started = threading.Event()
        self.release_create = threading.Event()
        self.create_lock = threading.Lock()
        self.create_call_count = 0

    def create_quotation_draft(self, payload):
        with self.create_lock:
            self.create_call_count += 1
        self.create_started.set()
        if not self.release_create.wait(timeout=10):
            raise RuntimeError("test fake timed out")
        self.read_result = deepcopy(self.create_result)
        return deepcopy(self.create_result)

    def get_quotation_draft(self, name):
        if self.read_result is None:
            raise ErpNextError("not_found", "not yet visible")
        return super().get_quotation_draft(name)


class _LateFailureUpdateClient(DraftClient):
    def __init__(self):
        super().__init__()
        self.update_started = threading.Event()
        self.release_update = threading.Event()

    def update_quotation_draft(self, name, payload, *, expected_modified):
        self.update_calls.append((name, deepcopy(payload), expected_modified))
        self.update_started.set()
        if not self.release_update.wait(timeout=10):
            raise RuntimeError("blocked update fake timed out")
        raise ErpNextError("unavailable", "late update outcome")


class _LateFailureReadbackClient(DraftClient):
    def __init__(self):
        super().__init__()
        self.read_lock = threading.Lock()
        self.read_count = 0
        self.original_read_started = threading.Event()
        self.release_original_read = threading.Event()

    def get_quotation_draft(self, name):
        with self.read_lock:
            self.read_count += 1
            read_number = self.read_count
        if read_number == 2:
            self.original_read_started.set()
            if not self.release_original_read.wait(timeout=10):
                raise RuntimeError("blocked readback fake timed out")
            raise ErpNextError("unavailable", "late readback outcome")
        return super().get_quotation_draft(name)


@override_settings(
    TRADELOOM_ERPNEXT_BASE_URL="https://erp.example.test",
    TRADELOOM_ERPNEXT_INSTANCE_ID="test-instance",
    TRADELOOM_ERPNEXT_API_KEY="test-key",
    TRADELOOM_ERPNEXT_API_SECRET="test-secret",
)
class ErpNextDraftConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="并发草稿测试批次", mode="demo", status="active",
            created_at=now, updated_at=now,
        )
        self.workflow = WorkflowTask.objects.create(
            batch=self.batch, user_goal="并发保存报价", task_type="prepare_product_data",
        )
        self.url = "/api/erpnext/quotation-drafts"
        self.remote = _BlockingDraftClient()

    def _thread_post(self, key, payload, results, exceptions):
        close_old_connections()
        try:
            client = Client()
            response = client.post(
                self.url,
                data=json.dumps({
                    "idempotency_key": key,
                    "payload": payload,
                    "workflow_id": self.workflow.id,
                }),
                content_type="application/json",
            )
            results.append(response)
        except BaseException as exc:
            exceptions.append(exc)
        finally:
            close_old_connections()

    def _thread_put(self, url, key, payload, results, exceptions):
        close_old_connections()
        try:
            response = Client().put(
                url,
                data=json.dumps({
                    "idempotency_key": key,
                    "expected_modified": "2026-10-21 12:00:00.000000",
                    "payload": payload,
                }),
                content_type="application/json",
            )
            results.append(response)
        except BaseException as exc:
            exceptions.append(exc)
        finally:
            close_old_connections()

    def _create_target(self, remote):
        with patch("workbench.erpnext.api._client_from_settings", return_value=remote):
            response = Client().post(
                self.url,
                data=json.dumps({"idempotency_key": f"target-{uuid.uuid4().hex}", "payload": quotation_input()}),
                content_type="application/json",
            )
        self.assertEqual(response.status_code, 201)
        return response.json()["operation_id"]

    def _race_same_key(self, second_payload):
        results = []
        exceptions = []
        observed_status = None
        with patch("workbench.erpnext.api._client_from_settings", return_value=self.remote):
            first = threading.Thread(
                target=self._thread_post,
                args=("same-concurrent-key", quotation_input(), results, exceptions),
            )
            first.start()
            second_results = []
            second = None
            try:
                self.assertTrue(self.remote.create_started.wait(timeout=10))
                operation = ErpNextDraftOperation.objects.get(idempotency_key="same-concurrent-key")
                observed_status = operation.status
                second = threading.Thread(
                    target=self._thread_post,
                    args=("same-concurrent-key", second_payload, second_results, exceptions),
                )
                second.start()
                second.join(timeout=10)
                self.assertFalse(second.is_alive(), "replay request did not finish while remote write was blocked")
            finally:
                self.remote.release_create.set()
                if second is not None:
                    second.join(timeout=10)
                first.join(timeout=10)
            self.assertFalse(first.is_alive(), "original request did not finish after remote write was released")

        self.assertEqual(exceptions, [])
        self.assertEqual(len(results), 1)
        self.assertEqual(len(second_results), 1)
        return observed_status, results[0], second_results[0]

    def test_concurrent_same_key_same_payload_sends_at_most_one_remote_create(self):
        observed_status, original, replay = self._race_same_key(quotation_input())

        self.assertEqual(observed_status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(self.remote.create_call_count, 1)
        self.assertEqual(original.status_code, 201)
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(original.json()["operation_id"], replay.json()["operation_id"])
        self.assertEqual(original.json()["status"], ErpNextDraftOperation.Status.SUCCEEDED)

    def test_concurrent_same_key_different_payload_conflicts_without_second_write(self):
        observed_status, original, conflict = self._race_same_key(quotation_input(party_name="CUST-002"))

        self.assertEqual(observed_status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(self.remote.create_call_count, 1)
        self.assertEqual(original.status_code, 201)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error_code"], "idempotency_conflict")

    def test_hard_interruption_after_reservation_replay_never_retries_create(self):
        class SimulatedProcessInterruption(BaseException):
            pass

        class InterruptingClient(DraftClient):
            def create_quotation_draft(inner_self, payload):
                inner_self.create_calls.append(deepcopy(payload))
                raise SimulatedProcessInterruption()

        client = InterruptingClient()
        with patch("workbench.erpnext.api._client_from_settings", return_value=client):
            with self.assertRaises(SimulatedProcessInterruption):
                Client().post(
                    self.url,
                    data=json.dumps({
                        "idempotency_key": "crash-after-reserve",
                        "payload": quotation_input(),
                    }),
                    content_type="application/json",
                )

        operation = ErpNextDraftOperation.objects.get(idempotency_key="crash-after-reserve")
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.remote_name, "")

        force_legacy_reserved_row(operation)

        with patch("workbench.erpnext.api._client_from_settings", return_value=client):
            replay = Client().post(
                self.url,
                data=json.dumps({
                    "idempotency_key": "crash-after-reserve",
                    "payload": quotation_input(),
                }),
                content_type="application/json",
            )

        operation.refresh_from_db()
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json()["status"], ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.OUTCOME_UNKNOWN)
        self.assertEqual(operation.remote_name, "")
        self.assertEqual(len(client.create_calls), 1)

    def test_late_original_update_failure_cannot_overwrite_replay_success(self):
        remote = _LateFailureUpdateClient()
        target_id = self._create_target(remote)
        target_before = ErpNextDraftOperation.objects.get(pk=target_id).receipt
        payload = quotation_input(party_name="CUST-002")
        remote.read_result = quote_record()
        remote.read_result["data"]["modified"] = "2026-10-21 12:30:00.000000"
        remote.read_result["data"].update({"party_name": payload["party_name"]})
        remote.read_result["external_ref"]["modified"] = remote.read_result["data"]["modified"]
        url = f"{self.url}/{target_id}"
        first_results, exceptions = [], []
        with patch("workbench.erpnext.api._client_from_settings", return_value=remote):
            first = threading.Thread(
                target=self._thread_put,
                args=(url, "update-race-key", payload, first_results, exceptions),
            )
            first.start()
            try:
                self.assertTrue(remote.update_started.wait(timeout=10), "original update did not reach remote fake")
                replay = Client().put(
                    url,
                    data=json.dumps({
                        "idempotency_key": "update-race-key",
                        "expected_modified": "2026-10-21 12:00:00.000000",
                        "payload": payload,
                    }),
                    content_type="application/json",
                )
            finally:
                remote.release_update.set()
                first.join(timeout=10)

        self.assertFalse(first.is_alive(), "original update did not finish after remote fake release")
        self.assertEqual(exceptions, [])
        self.assertEqual(len(first_results), 1)
        self.assertEqual(replay.status_code, 200, replay.content.decode())
        self.assertEqual(first_results[0].status_code, 200)
        self.assertEqual(first_results[0].json()["operation_id"], replay.json()["operation_id"])
        self.assertEqual(first_results[0].json()["status"], ErpNextDraftOperation.Status.SUCCEEDED)
        operation = ErpNextDraftOperation.objects.get(pk=replay.json()["operation_id"])
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.SUCCEEDED)
        self.assertEqual(operation.receipt["data"]["party_name"], "CUST-002")
        self.assertEqual(ErpNextDraftOperation.objects.get(pk=target_id).receipt, target_before)
        self.assertEqual(EventLog.objects.filter(event_type="erpnext_draft_succeeded").count(), 2)

    def test_late_original_readback_failure_cannot_overwrite_read_reconciliation(self):
        remote = _LateFailureReadbackClient()
        target_id = self._create_target(remote)
        target_before = ErpNextDraftOperation.objects.get(pk=target_id).receipt
        payload = quotation_input(party_name="CUST-002")
        url = f"{self.url}/{target_id}"
        first_results, exceptions = [], []
        with patch("workbench.erpnext.api._client_from_settings", return_value=remote):
            first = threading.Thread(
                target=self._thread_put,
                args=(url, "readback-race-key", payload, first_results, exceptions),
            )
            first.start()
            try:
                self.assertTrue(remote.original_read_started.wait(timeout=10), "original readback did not block")
                update_operation = ErpNextDraftOperation.objects.get(idempotency_key="readback-race-key")
                replay = Client().get(f"{self.url}/{update_operation.pk}")
            finally:
                remote.release_original_read.set()
                first.join(timeout=10)

        self.assertFalse(first.is_alive(), "original readback did not finish after release")
        self.assertEqual(exceptions, [])
        self.assertEqual(len(first_results), 1)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first_results[0].status_code, 200)
        self.assertEqual(first_results[0].json()["status"], ErpNextDraftOperation.Status.SUCCEEDED)
        operation = ErpNextDraftOperation.objects.get(pk=replay.json()["operation_id"])
        self.assertEqual(operation.status, ErpNextDraftOperation.Status.SUCCEEDED)
        self.assertEqual(operation.receipt["data"]["party_name"], "CUST-002")
        self.assertEqual(ErpNextDraftOperation.objects.get(pk=target_id).receipt, target_before)
        self.assertEqual(EventLog.objects.filter(event_type="erpnext_draft_succeeded").count(), 2)

    def _assert_stale_unknown_save_cannot_overwrite_terminal(self, terminal_status):
        operation = ErpNextDraftOperation.objects.create(
            instance_id="test-instance", idempotency_key=f"terminal-race-{terminal_status}",
            action=ErpNextDraftOperation.Action.CREATE, fingerprint="a" * 64,
            payload_sha256="b" * 64, request_payload=quotation_input(), doctype="Quotation",
            source=ErpNextDraftOperation.Source.LOCAL_WORKBENCH,
            status=ErpNextDraftOperation.Status.OUTCOME_UNKNOWN,
            remote_name="QTN-2026-00001",
        )
        stale = ErpNextDraftOperation.objects.get(pk=operation.pk)
        stale.status = ErpNextDraftOperation.Status.OUTCOME_UNKNOWN
        stale.error_code = "unavailable"
        stale.receipt = None
        stale.remote_modified = ""
        stale.result_ref = {}

        guard_read = threading.Event()
        allow_update = threading.Event()
        terminal_started = threading.Event()
        terminal_done = threading.Event()
        errors = []

        def pause_stale_write(sender, instance, raw, **_kwargs):
            if raw or instance.pk != operation.pk or threading.current_thread().name != "stale-erp-write":
                return
            guard_read.set()
            if not allow_update.wait(timeout=10):
                raise TimeoutError("stale model save was not released")

        pre_save.connect(pause_stale_write, sender=ErpNextDraftOperation, weak=False)

        def stale_writer():
            close_old_connections()
            try:
                stale.save(update_fields=["status", "error_code", "receipt", "remote_modified", "result_ref", "updated_at"])
            except BaseException as exc:
                errors.append(exc)
            finally:
                close_old_connections()

        def terminal_writer():
            close_old_connections()
            try:
                terminal_started.set()
                terminal = ErpNextDraftOperation.objects.get(pk=operation.pk)
                terminal.status = terminal_status
                terminal.error_code = "conflict" if terminal_status == ErpNextDraftOperation.Status.CONFLICT else ""
                if terminal_status == ErpNextDraftOperation.Status.SUCCEEDED:
                    terminal.receipt = quote_record()
                    terminal.result_ref = terminal.receipt["external_ref"]
                    terminal.remote_modified = terminal.receipt["external_ref"]["modified"]
                terminal.save(update_fields=["status", "error_code", "receipt", "result_ref", "remote_modified", "updated_at"])
            except BaseException as exc:
                errors.append(exc)
            finally:
                terminal_done.set()
                close_old_connections()

        worker = threading.Thread(target=stale_writer, name="stale-erp-write")
        worker.start()
        terminal_worker = None
        try:
            self.assertTrue(guard_read.wait(timeout=10), "stale writer did not reach pre-save after its guard read")
            terminal_worker = threading.Thread(target=terminal_writer, name="terminal-erp-write")
            terminal_worker.start()
            self.assertTrue(terminal_started.wait(timeout=10))
            self.assertFalse(terminal_done.wait(timeout=0.25), "terminal writer should wait for the guarded stale save")
        finally:
            allow_update.set()
            worker.join(timeout=10)
            if terminal_worker is not None:
                terminal_worker.join(timeout=10)
            pre_save.disconnect(pause_stale_write, sender=ErpNextDraftOperation)

        self.assertFalse(worker.is_alive(), "stale writer did not finish")
        self.assertIsNotNone(terminal_worker)
        self.assertFalse(terminal_worker.is_alive(), "terminal writer did not finish after stale save")
        self.assertEqual(errors, [])
        operation.refresh_from_db()
        self.assertEqual(operation.status, terminal_status)
        if terminal_status == ErpNextDraftOperation.Status.SUCCEEDED:
            self.assertEqual(operation.receipt["data"]["name"], "QTN-2026-00001")
            self.assertEqual(operation.result_ref, operation.receipt["external_ref"])
        else:
            self.assertIsNone(operation.receipt)

    def test_stale_unknown_write_cannot_erase_succeeded_receipt_after_guard_read(self):
        self._assert_stale_unknown_save_cannot_overwrite_terminal(ErpNextDraftOperation.Status.SUCCEEDED)

    def test_stale_unknown_write_cannot_reopen_conflict_after_guard_read(self):
        self._assert_stale_unknown_save_cannot_overwrite_terminal(ErpNextDraftOperation.Status.CONFLICT)
