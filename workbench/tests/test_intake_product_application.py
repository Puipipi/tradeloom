from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone as datetime_timezone
from io import BytesIO
from pathlib import Path
from threading import Barrier
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections
from django.test import Client, TransactionTestCase, override_settings
from openpyxl import Workbook

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT
from workbench.intake.schemas import SCHEMA_VERSION
from workbench.models import (
    ErpNextDraftOperation, IntakeCandidate, IntakeOperationReceipt,
    Product, ProductRevision, Task,
)


def synthetic_product_identity_xlsx() -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Synthetic"
    for coordinate, value in {
        "A1": "STYLE-001", "B1": "Synthetic item", "C1": 30,
        "D1": "cm", "E1": 50, "F1": "m", "G1": "navy",
    }.items():
        sheet[coordinate] = value
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


class IntakeProductApplicationApiTests(TransactionTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "data"
        self.intake_root = self.data_root / "private" / "intake"
        self.intake_root.mkdir(parents=True)
        (self.intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        self.settings = override_settings(
            TRADELOOM_DATA_ROOT=self.data_root,
            TRADELOOM_INTAKE_ROOT=self.intake_root,
        )
        self.settings.enable()
        self.client = Client()
        self.candidate = self._create_candidate()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def _create_candidate(self):
        uploaded = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile("synthetic-identity.xlsx", synthetic_product_identity_xlsx(), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY="product-apply-upload",
        )
        self.assertEqual(uploaded.status_code, 201)
        source = uploaded.json()["source"]
        previewed = self.client.post(
            f"/api/intake/sources/{source['id']}/previews",
            data="{}", content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-preview",
        )
        self.assertEqual(previewed.status_code, 201)
        preview = previewed.json()["preview"]
        mapping = {
            "schema_version": 1,
            "candidate_type": "product_identity",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                name: {"cells": [{"sheet_index": 1, "coordinate": coordinate}]}
                for name, coordinate in {
                    "style_number": "A1", "description": "B1", "width": "C1",
                    "width_unit": "D1", "roll_length": "E1", "roll_length_unit": "F1",
                    "color": "G1",
                }.items()
            },
        }
        mapped = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings",
            data=json.dumps(mapping), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-mapping",
        )
        self.assertEqual(mapped.status_code, 201)
        created = self.client.post(
            f"/api/intake/mappings/{mapped.json()['mapping']['id']}/candidates",
            data="{}", content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-candidate",
        )
        self.assertEqual(created.status_code, 201)
        return IntakeCandidate.objects.get(pk=created.json()["candidate"]["id"])

    def _task(self, *, status="confirmed"):
        now = datetime.now(datetime_timezone.utc)
        return Task.objects.create(title="Synthetic task", mode="manual", status=status, created_at=now, updated_at=now)

    def _payload(self, task, **overrides):
        candidate = self.candidate
        payload = {
            "source_sha256": candidate.source_sha256,
            "mapping_id": candidate.mapping_revision_id,
            "mapping_revision": candidate.mapping_revision.revision,
            "target": {"task_id": task.pk, "product_id": None, "expected_revision_id": None},
            "fields": {
                "sku": {"value": "STYLE-001", "source_fields": ["style_number"], "note": ""},
                "name": {"value": "Synthetic item", "source_fields": ["description"], "note": ""},
                "size": {"value": "30 cm × 50 m", "source_fields": ["width", "width_unit", "roll_length", "roll_length_unit"], "note": ""},
                "color": {"value": "navy", "source_fields": ["color"], "note": ""},
            },
        }
        payload.update(overrides)
        return payload

    def _force_fixture_update(self, model, object_id, **values):
        # Simulate a corrupt/future append-only row that normal APIs cannot write.
        model._base_manager.filter(pk=object_id).update(**values)

    def test_apply_creates_nonconfirmed_product_revision_and_replays_frozen_receipt(self):
        task = self._task(status="confirmed")
        erp_operation_count = ErpNextDraftOperation.objects.count()
        payload = self._payload(task)
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-new-001",
        )

        self.assertEqual(response.status_code, 201)
        body = response.json()
        self.assertEqual(body["status"], "succeeded")
        self.assertEqual(body["application"]["status"], "needs_review")
        self.assertEqual(Product.objects.count(), 1)
        self.assertEqual(ErpNextDraftOperation.objects.count(), erp_operation_count)
        product = Product.objects.get()
        revision = ProductRevision.objects.get(product=product)
        self.assertEqual(product.task_id, task.pk)
        self.assertEqual((product.sku, product.name, product.size, product.color), ("STYLE-001", "Synthetic item", "30 cm × 50 m", "navy"))
        self.assertEqual(product.category, "")
        self.assertEqual(product.material, "")
        self.assertEqual(product.image_filename, "")
        self.assertTrue(product.missing_fields)
        self.assertEqual(revision.status, "needs_review")
        self.assertEqual(revision.source_refs["intake_application"]["candidate_id"], self.candidate.pk)
        task.refresh_from_db()
        self.assertEqual(task.status, "awaiting_confirmation")
        confirm = self.client.post(f"/api/tasks/{task.pk}/confirm")
        self.assertEqual(confirm.status_code, 409)
        task.refresh_from_db()
        revision.refresh_from_db()
        self.assertEqual(task.status, "awaiting_confirmation")
        self.assertEqual(revision.status, "needs_review")

        first_dto = body["application"]
        detail = self.client.get(f"/api/intake/candidates/{self.candidate.pk}")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["applications"], [first_dto])
        product.name = "Later reviewed name"
        product.save(update_fields=["name"])
        revision.status = "confirmed"
        revision.save(update_fields=["status"])
        replay = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-new-001",
        )
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["application"], first_dto)
        self.assertEqual(Product.objects.count(), 1)
        self.assertEqual(ProductRevision.objects.filter(product=product).count(), 1)
        replay_with_new_key = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-new-002",
        )
        self.assertEqual(replay_with_new_key.status_code, 200)
        self.assertEqual(replay_with_new_key.json()["application"], first_dto)
        self.assertNotIn("request_fingerprint", first_dto)
        self.assertEqual(IntakeOperationReceipt.objects.filter(action="product_application").count(), 2)
        history_after_change = self.client.get(f"/api/intake/candidates/{self.candidate.pk}")
        self.assertEqual(history_after_change.json()["applications"], [first_dto])

    def test_candidate_detail_returns_bounded_frozen_application_receipts(self):
        task = self._task(status="draft")
        now = datetime.now(datetime_timezone.utc)
        for index in range(21):
            product = Product.objects.create(
                task=task, position=index + 1, sku=f"SKU-{index}", name=f"Product {index}",
                category="", material="", size="", color="", image_filename="",
                image_stored_name="", missing_fields=[], created_at=now, updated_at=now,
            )
            application = {"candidate_id": self.candidate.pk, "product_id": product.pk,
                           "revision_id": f"{index + 1:032x}", "version": 1,
                           "status": "needs_review", "missing_fields": ["材质"]}
            ProductRevision.objects.create(
                product=product, version=1, snapshot={"sku": product.sku, "name": product.name},
                field_sources={}, status="needs_review", source_refs={
                    "intake_candidate_id": self.candidate.pk, "intake_application": application,
                },
            )
            IntakeOperationReceipt.objects.create(
                idempotency_key=f"product-history-{index:02d}", action="product_application",
                fingerprint=f"{index + 1:064x}", state=IntakeOperationReceipt.State.SUCCEEDED,
                result_type="product_application", result_id=product.revisions.get().pk,
            )

        first_page = self.client.get(f"/api/intake/candidates/{self.candidate.pk}")
        self.assertEqual(first_page.status_code, 200)
        self.assertEqual(len(first_page.json()["applications"]), 20)
        self.assertEqual(first_page.json()["applications_next_offset"], 20)
        last_page = self.client.get(
            f"/api/intake/candidates/{self.candidate.pk}?applications_offset=20&applications_limit=20"
        )
        self.assertEqual(len(last_page.json()["applications"]), 1)
        self.assertIsNone(last_page.json()["applications_next_offset"])

    def test_apply_appends_existing_revision_without_losing_other_facts_or_provenance(self):
        task = self._task(status="awaiting_confirmation")
        now = datetime.now(datetime_timezone.utc)
        product = Product.objects.create(
            task=task, position=1, sku="KEEP-SKU", name="Keep name", category="",
            material="cotton", size="old size", color="red", image_filename="keep.png",
            image_stored_name="stored-keep.png", missing_fields=["品类"],
            created_at=now, updated_at=now,
        )
        first = ProductRevision.objects.create(
            product=product, version=1,
            snapshot={"sku": product.sku, "name": product.name, "category": "",
                      "material": product.material, "size": product.size, "color": product.color,
                      "image_filename": product.image_filename, "english_name": "Approved English",
                      "custom_note": "preserve this"},
            field_sources={"sku": "human_review:prior", "english_name": "human_review:prior"},
            status="needs_review", reviewer="", source_refs={"source": "prior", "image": {"stored_name": "stored-keep.png"}},
        )
        revision_listing = self.client.get(f"/api/products/{product.pk}/revisions")
        self.assertEqual(revision_listing.status_code, 200)
        self.assertEqual(revision_listing.json()["revisions"][0]["id"], first.pk)

        payload = self._payload(task)
        payload["target"] = {"task_id": task.pk, "product_id": product.pk, "expected_revision_id": first.pk}
        payload["fields"] = {"color": {"value": "navy", "source_fields": ["color"], "note": ""}}
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-existing-001",
        )
        self.assertEqual(response.status_code, 201)
        product.refresh_from_db()
        second = ProductRevision.objects.get(product=product, version=2)
        self.assertEqual((product.sku, product.name, product.color), ("KEEP-SKU", "Keep name", "navy"))
        self.assertEqual(second.snapshot["english_name"], "Approved English")
        self.assertEqual(second.snapshot["custom_note"], "preserve this")
        self.assertEqual(second.field_sources["sku"], "human_review:prior")
        self.assertEqual(second.field_sources["english_name"], "human_review:prior")
        self.assertEqual(second.field_sources["color"], f"human_review:intake_candidate:{self.candidate.pk}")
        self.assertEqual(second.source_refs["image"], {"stored_name": "stored-keep.png"})
        self.assertEqual(second.source_refs["source"], "intake")
        self.assertEqual(second.source_refs["prior_revision_id"], first.pk)
        self.assertEqual(second.status, "needs_review")
        self.assertEqual(task.status, "awaiting_confirmation")

        stale = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps({**payload, "fields": {"color": {"value": "red", "source_fields": ["color"], "note": ""}}}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-existing-002",
        )
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(ProductRevision.objects.filter(product=product).count(), 2)

    def test_each_existing_application_receipt_contains_only_its_submitted_fields(self):
        task = self._task(status="awaiting_confirmation")
        now = datetime.now(datetime_timezone.utc)
        product = Product.objects.create(
            task=task, position=1, sku="KEEP-SKU", name="Keep name", category="fabric",
            material="cotton", size="old size", color="red", image_filename="",
            image_stored_name="", missing_fields=[], created_at=now, updated_at=now,
        )
        first = ProductRevision.objects.create(
            product=product, version=1,
            snapshot={"sku": product.sku, "name": product.name, "category": product.category,
                      "material": product.material, "size": product.size, "color": product.color,
                      "image_filename": ""},
            field_sources={}, status="needs_review", reviewer="", source_refs={"source": "legacy"},
        )
        endpoint = f"/api/intake/candidates/{self.candidate.pk}/apply"
        color_payload = self._payload(task)
        color_payload["target"] = {"task_id": task.pk, "product_id": product.pk,
                                    "expected_revision_id": first.pk}
        color_payload["fields"] = {"color": {"value": "navy", "source_fields": ["color"], "note": ""}}
        color_response = self.client.post(
            endpoint, data=json.dumps(color_payload), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="product-apply-color-first",
        )
        self.assertEqual(color_response.status_code, 201)
        first_application = color_response.json()["application"]
        color_revision_id = first_application["revision_id"]
        self.assertEqual(set(first_application["source_refs"]["intake_fields"]), {"color"})

        size_payload = self._payload(task)
        size_payload["target"] = {"task_id": task.pk, "product_id": product.pk,
                                   "expected_revision_id": color_revision_id}
        size_payload["fields"] = {"size": {"value": "new size", "source_fields": [],
                                            "note": "人工确认尺寸"}}
        size_response = self.client.post(
            endpoint, data=json.dumps(size_payload), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="product-apply-size-second",
        )
        self.assertEqual(size_response.status_code, 201)
        second_application = size_response.json()["application"]
        self.assertEqual(set(second_application["source_refs"]["intake_fields"]), {"size"})

        latest = ProductRevision.objects.get(product=product, version=3)
        self.assertEqual(set(latest.source_refs["intake_fields"]), {"color", "size"})
        self.assertEqual(latest.source_refs["intake_application"]["source_refs"]["intake_fields"],
                         second_application["source_refs"]["intake_fields"])
        self.assertEqual(first_application["source_refs"]["intake_fields"].keys(), {"color"})

        history = self.client.get(f"/api/intake/candidates/{self.candidate.pk}")
        self.assertEqual(history.status_code, 200)
        by_revision = {item["revision_id"]: item for item in history.json()["applications"]}
        self.assertEqual(set(by_revision[color_revision_id]["source_refs"]["intake_fields"]), {"color"})
        self.assertEqual(set(by_revision[second_application["revision_id"]]["source_refs"]["intake_fields"]),
                         {"size"})

    def test_existing_product_cannot_be_applied_with_blank_final_identity(self):
        task = self._task(status="draft")
        now = datetime.now(datetime_timezone.utc)
        product = Product.objects.create(
            task=task, position=1, sku="SKU", name="Name", category="", material="",
            size="", color="", image_filename="", image_stored_name="", missing_fields=[],
            created_at=now, updated_at=now,
        )
        revision = ProductRevision.objects.create(
            product=product, version=1, snapshot={"sku": "SKU", "name": "Name"},
            field_sources={}, status="draft", source_refs={},
        )
        payload = self._payload(task)
        payload["target"] = {"task_id": task.pk, "product_id": product.pk, "expected_revision_id": revision.pk}
        payload["fields"] = {"sku": {"value": "", "source_fields": [], "note": "remove sku"}}
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-blank-identity",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(ProductRevision.objects.filter(product=product).count(), 1)
        product.refresh_from_db()
        self.assertEqual(product.sku, "SKU")

    def test_empty_product_id_is_not_treated_as_a_new_product_target(self):
        task = self._task(status="draft")
        payload = self._payload(task)
        payload["target"]["product_id"] = ""
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-empty-target",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(Product.objects.count(), 0)
        self.assertEqual(ProductRevision.objects.count(), 0)

    def test_missing_idempotency_key_has_its_own_error_code(self):
        task = self._task(status="draft")
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(self._payload(task)), content_type="application/json",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "invalid_idempotency_key")
        self.assertEqual(Product.objects.count(), 0)

    def test_source_unit_pair_and_closed_request_validation(self):
        task = self._task(status="draft")
        payload = self._payload(task)
        payload["fields"]["size"]["source_fields"] = ["width"]
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-unit-pair",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "incomplete_source_unit")
        self.assertEqual(Product.objects.count(), 0)

        payload = self._payload(task)
        payload["unchecked"] = True
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply",
            data=json.dumps(payload), content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-closed-body",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "invalid_application")
        self.assertEqual(IntakeOperationReceipt.objects.filter(action="product_application").count(), 0)

    def test_same_key_with_changed_request_conflicts_but_explicit_variant_is_allowed(self):
        task = self._task(status="draft")
        payload = self._payload(task)
        endpoint = f"/api/intake/candidates/{self.candidate.pk}/apply"
        first = self.client.post(endpoint, data=json.dumps(payload), content_type="application/json",
                                 HTTP_IDEMPOTENCY_KEY="product-apply-key-conflict")
        self.assertEqual(first.status_code, 201)
        changed = {**payload, "fields": {**payload["fields"], "sku": {
            "value": "STYLE-OTHER", "source_fields": ["style_number"], "note": ""}}}
        conflict = self.client.post(endpoint, data=json.dumps(changed), content_type="application/json",
                                    HTTP_IDEMPOTENCY_KEY="product-apply-key-conflict")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(Product.objects.count(), 1)

        variant = {**changed, "fields": {**changed["fields"], "name": {
            "value": "Explicit alternate variant", "source_fields": [], "note": "由用户明确作为另一变体"}}}
        second = self.client.post(endpoint, data=json.dumps(variant), content_type="application/json",
                                  HTTP_IDEMPOTENCY_KEY="product-apply-explicit-variant")
        self.assertEqual(second.status_code, 201)
        self.assertEqual(Product.objects.count(), 2)

    def test_concurrent_identical_requests_create_one_product_and_replay_one_revision(self):
        task = self._task(status="draft")
        payload = json.dumps(self._payload(task))
        endpoint = f"/api/intake/candidates/{self.candidate.pk}/apply"
        barrier = Barrier(2)

        def send():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return Client().post(endpoint, data=payload, content_type="application/json",
                                     HTTP_IDEMPOTENCY_KEY="product-apply-concurrent-same")
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _index: send(), range(2)))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 201])
        self.assertEqual(responses[0].json()["application"], responses[1].json()["application"])
        self.assertEqual(Product.objects.count(), 1)
        self.assertEqual(ProductRevision.objects.count(), 1)
        self.assertEqual(IntakeOperationReceipt.objects.filter(idempotency_key="product-apply-concurrent-same").count(), 1)

    def test_concurrent_same_request_with_different_keys_reuses_one_application(self):
        task = self._task(status="draft")
        payload = json.dumps(self._payload(task))
        endpoint = f"/api/intake/candidates/{self.candidate.pk}/apply"
        barrier = Barrier(2)

        def send(key):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return Client().post(endpoint, data=payload, content_type="application/json",
                                     HTTP_IDEMPOTENCY_KEY=key)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(send, ("product-apply-race-a", "product-apply-race-b")))
        self.assertEqual(sorted(response.status_code for response in responses), [200, 201])
        self.assertEqual(responses[0].json()["application"], responses[1].json()["application"])
        self.assertEqual(Product.objects.count(), 1)
        self.assertEqual(ProductRevision.objects.count(), 1)
        self.assertEqual(IntakeOperationReceipt.objects.filter(action="product_application").count(), 2)

    def test_concurrent_existing_updates_with_same_revision_allow_only_one(self):
        task = self._task(status="awaiting_confirmation")
        now = datetime.now(datetime_timezone.utc)
        product = Product.objects.create(
            task=task, position=1, sku="KEEP-SKU", name="Keep name", category="", material="",
            size="", color="red", image_filename="", image_stored_name="", missing_fields=[],
            created_at=now, updated_at=now,
        )
        revision = ProductRevision.objects.create(
            product=product, version=1, snapshot={"sku": product.sku, "name": product.name, "color": "red"},
            field_sources={}, status="needs_review", source_refs={},
        )
        endpoint = f"/api/intake/candidates/{self.candidate.pk}/apply"
        bodies = [json.dumps({**self._payload(task),
                              "target": {"task_id": task.pk, "product_id": product.pk,
                                         "expected_revision_id": revision.pk},
                              "fields": {"color": {"value": color, "source_fields": ["color"], "note": ""}}})
                  for color in ("navy", "green")]
        barrier = Barrier(2)

        def send(body, key):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return Client().post(endpoint, data=body, content_type="application/json",
                                     HTTP_IDEMPOTENCY_KEY=key)
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda pair: send(*pair), zip(bodies, ("product-race-color-a", "product-race-color-b"))))
        self.assertEqual(sorted(response.status_code for response in responses), [201, 409])
        self.assertEqual(ProductRevision.objects.filter(product=product).count(), 2)
        product.refresh_from_db()
        self.assertIn(product.color, {"navy", "green"})

    def test_stale_and_unready_sources_are_rejected_but_old_frozen_mapping_remains_applicable(self):
        task = self._task(status="draft")
        payload = self._payload(task)
        stale_hash = {**payload, "source_sha256": "d" * 64}
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply", data=json.dumps(stale_hash),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-stale-source-hash",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error_code"], "stale_mapping")

        snapshot = self.candidate.mapping_revision.snapshot
        self._force_fixture_update(type(snapshot), snapshot.pk, status="failed")
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply", data=json.dumps(payload),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-unready-source",
        )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error_code"], "stale_mapping")
        self._force_fixture_update(type(snapshot), snapshot.pk, status="ready")

        mapping = dict(self.candidate.mapping_revision.mapping)
        mapping["expected_revision"] = self.candidate.mapping_revision.revision
        newer = self.client.post(
            f"/api/intake/previews/{snapshot.pk}/mappings", data=json.dumps(mapping),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-newer-mapping",
        )
        self.assertEqual(newer.status_code, 201)
        self.assertEqual(newer.json()["mapping"]["revision"], self.candidate.mapping_revision.revision + 1)
        old_candidate_apply = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply", data=json.dumps(payload),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-frozen-old-mapping",
        )
        self.assertEqual(old_candidate_apply.status_code, 201)

    def test_unsupported_type_and_unresolved_formula_cache_sources_are_rejected(self):
        task = self._task(status="draft")
        payload = self._payload(task)
        original_schema = self.candidate.schema_version
        original_mapping_schema = self.candidate.mapping_revision.schema_version
        original_payload = self.candidate.typed_payload
        self._force_fixture_update(IntakeCandidate, self.candidate.pk, schema_version=SCHEMA_VERSION + 1)
        mapping_revision = self.candidate.mapping_revision
        future_payload = json.loads(json.dumps(original_payload))
        future_payload["schema_version"] = SCHEMA_VERSION + 1
        self._force_fixture_update(IntakeCandidate, self.candidate.pk, typed_payload=future_payload)
        self._force_fixture_update(type(mapping_revision), mapping_revision.pk, schema_version=SCHEMA_VERSION + 1)
        future_schema = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply", data=json.dumps(payload),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-unsupported-schema",
        )
        self.assertEqual(future_schema.status_code, 422)
        self.assertEqual(future_schema.json()["error_code"], "unsupported_schema")
        self._force_fixture_update(IntakeCandidate, self.candidate.pk, schema_version=original_schema,
                                   typed_payload=original_payload)
        self._force_fixture_update(type(mapping_revision), mapping_revision.pk,
                                   schema_version=original_mapping_schema)

        original_type = self.candidate.candidate_type
        original_mapping_type = self.candidate.mapping_revision.candidate_type
        unsupported_payload = json.loads(json.dumps(original_payload))
        unsupported_payload["candidate_type"] = "unsupported_kind"
        self._force_fixture_update(IntakeCandidate, self.candidate.pk, candidate_type="unsupported_kind",
                                   typed_payload=unsupported_payload)
        self._force_fixture_update(type(mapping_revision), mapping_revision.pk,
                                   candidate_type="unsupported_kind")
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate.pk}/apply", data=json.dumps(payload),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-unsupported-type",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "unsupported_candidate_type")
        self._force_fixture_update(IntakeCandidate, self.candidate.pk, candidate_type=original_type,
                                   typed_payload=original_payload)
        self._force_fixture_update(type(mapping_revision), mapping_revision.pk,
                                   candidate_type=original_mapping_type)

        for state in ("formula_error", "formula_cache_missing", "formula_cache_empty", "type_mismatch"):
            changed = json.loads(json.dumps(original_payload))
            changed["fields"]["style_number"][0].update(state=state, value=None)
            self._force_fixture_update(IntakeCandidate, self.candidate.pk, typed_payload=changed)
            rejected = self.client.post(
                f"/api/intake/candidates/{self.candidate.pk}/apply", data=json.dumps(payload),
                content_type="application/json", HTTP_IDEMPOTENCY_KEY=f"product-unresolved-{state}",
            )
            self.assertEqual(rejected.status_code, 422, state)
            self.assertEqual(rejected.json()["error_code"], "unresolved_application_source", state)
        self._force_fixture_update(IntakeCandidate, self.candidate.pk, typed_payload=original_payload)
        self.assertEqual(Product.objects.count(), 0)

    def test_revision_write_failure_rolls_back_product_task_and_receipt(self):
        task = self._task(status="confirmed")
        payload = json.dumps(self._payload(task))
        with patch.object(ProductRevision.objects, "create", side_effect=RuntimeError("synthetic revision write failure")):
            response = self.client.post(
                f"/api/intake/candidates/{self.candidate.pk}/apply", data=payload,
                content_type="application/json", HTTP_IDEMPOTENCY_KEY="product-apply-rollback",
            )
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error_code"], "unavailable")
        self.assertEqual(Product.objects.count(), 0)
        self.assertEqual(ProductRevision.objects.count(), 0)
        self.assertEqual(IntakeOperationReceipt.objects.filter(action="product_application").count(), 0)
        task.refresh_from_db()
        self.assertEqual(task.status, "confirmed")
