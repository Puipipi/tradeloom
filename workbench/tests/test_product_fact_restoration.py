from __future__ import annotations

import json
import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import close_old_connections
from django.test import Client, TransactionTestCase
from django.utils import timezone

from workbench.models import Product, ProductRevision, Task, TaskFile
from workbench.products.versions import field_sources_from_product, image_source_ref, snapshot_from_product


SCOPE = ["name", "category", "material", "size", "color"]
FACTS = {
    "name": "历史名称",
    "category": "历史品类",
    "material": "历史材质",
    "size": "历史尺寸",
    "color": "历史颜色",
}


class ProductFactRestorationApiTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        self.bridge_key = "d" * 64
        self.bridge_env = patch.dict(os.environ, {"TRADELOOM_NATIVE_BRIDGE_KEY": self.bridge_key})
        self.bridge_env.start()
        self.addCleanup(self.bridge_env.stop)
        self.client = Client(enforce_csrf_checks=True)
        now = timezone.now()
        self.task = Task.objects.create(
            id=uuid.uuid4().hex, title="Owned restoration test", mode="csv", status="confirmed",
            created_at=now, updated_at=now,
        )
        self.product = Product.objects.create(
            id=uuid.uuid4().hex, task=self.task, position=0, sku="SKU-KEEP",
            name="当前名称", category="当前品类", material="当前材质", size="当前尺寸", color="当前颜色",
            image_filename="front.png", image_stored_name="stored-front.png", missing_fields=[],
            created_at=now, updated_at=now,
        )
        self.image = TaskFile.objects.create(
            id=uuid.uuid4().hex, task=self.task, kind="image", original_name="front.png",
            stored_name="stored-front.png", created_at=now,
        )
        self.source = self.make_revision(1, FACTS, status="confirmed", reviewer="old reviewer")
        self.current_revision = self.make_revision(2, self.live_facts(), status="confirmed", reviewer="current reviewer")
        self.preview_url = f"/api/products/{self.product.pk}/fact-restoration/preview"
        self.apply_url = f"/api/products/{self.product.pk}/fact-restoration/apply"

    def live_facts(self):
        return {key: getattr(self.product, key) for key in SCOPE}

    def make_revision(self, version, facts, *, status="needs_review", reviewer=""):
        snapshot = snapshot_from_product(self.product)
        snapshot.update(facts)
        return ProductRevision.objects.create(
            id=uuid.uuid4().hex, product=self.product, version=version, snapshot=snapshot,
            field_sources=field_sources_from_product(self.product), status=status,
            source_refs={"source": "test_fixture", "image": image_source_ref(self.product)},
            reviewer=reviewer,
        )

    def request(self, client, method, url, payload=None, *, key=None):
        headers = {"HTTP_X_TRADELOOM_NATIVE_BRIDGE": self.bridge_key if key is None else key}
        body = json.dumps(payload, ensure_ascii=True, separators=(",", ":")) if payload is not None else "{}"
        return client.generic(method, url, body, content_type="application/json", **headers)

    def preview(self, *, source=None, client=None, key=None, extra=None):
        payload = {"sourceRevisionId": source or self.source.pk}
        payload.update(extra or {})
        return self.request(client or self.client, "POST", self.preview_url, payload, key=key)

    def apply(self, preview, *, client=None, source=None, extra=None):
        baseline = preview
        payload = {
            "sourceRevisionId": source or baseline["sourceRevision"]["id"],
            "expectedLatestRevisionId": baseline["latestRevision"]["id"],
            "expectedLiveFingerprint": baseline["currentLiveFingerprint"],
            "previewDigest": baseline["previewDigest"],
            "confirm": True,
        }
        payload.update(extra or {})
        return self.request(client or self.client, "POST", self.apply_url, payload)

    def test_preview_is_read_only_and_returns_fixed_scope_and_digest(self):
        before_product = Product.objects.get(pk=self.product.pk)
        before_task = Task.objects.get(pk=self.task.pk)
        before_revisions = list(ProductRevision.objects.filter(product=self.product).order_by("version").values())

        response = self.preview()

        self.assertEqual(response.status_code, 200, response.content)
        preview = response.json()
        self.assertEqual(preview["scope"], SCOPE)
        self.assertEqual(preview["sourceRevision"]["id"], self.source.pk)
        self.assertEqual(preview["sourceRevision"]["version"], 1)
        self.assertRegex(preview["sourceRevision"]["snapshotSha256"], r"^[a-f0-9]{64}$")
        self.assertEqual(preview["current"], {"name": "当前名称", "category": "当前品类", "material": "当前材质", "size": "当前尺寸", "color": "当前颜色"})
        self.assertEqual(preview["target"], FACTS)
        self.assertEqual(set(preview["differences"]), set(SCOPE))
        self.assertFalse(preview["wouldCreateBackup"])
        self.assertFalse(preview["noOp"])
        self.assertRegex(preview["currentLiveFingerprint"], r"^[a-f0-9]{64}$")
        self.assertRegex(preview["previewDigest"], r"^[a-f0-9]{64}$")
        self.assertEqual(Product.objects.get(pk=self.product.pk), before_product)
        self.assertEqual(Task.objects.get(pk=self.task.pk), before_task)
        self.assertEqual(list(ProductRevision.objects.filter(product=self.product).order_by("version").values()), before_revisions)

    def test_source_field_limits_are_checked_but_empty_facts_remain_restorable(self):
        invalid_source = self.make_revision(3, {**FACTS, "name": "x" * 201})
        invalid = self.preview(source=invalid_source.pk)
        self.assertEqual(invalid.status_code, 409)
        self.assertEqual(invalid.json()["code"], "source_revision_invalid")

        empty_source = self.make_revision(4, {**FACTS, "name": ""})
        valid = self.preview(source=empty_source.pk)
        self.assertEqual(valid.status_code, 200, valid.content)
        self.assertEqual(valid.json()["target"]["name"], "")

    def test_bridge_and_strict_request_shapes_are_required(self):
        denied = self.preview(key="e" * 64)
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["code"], "native_bridge_forbidden")
        missing = self.preview(key="")
        self.assertEqual(missing.status_code, 403)
        self.assertEqual(missing.json()["code"], "native_bridge_forbidden")
        extra = self.preview(extra={"productId": self.product.pk})
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(extra.json()["code"], "invalid_request")
        preview = self.preview().json()
        rejected = self.apply(preview, extra={"confirm": False})
        self.assertEqual(rejected.status_code, 422)
        self.assertEqual(rejected.json()["code"], "invalid_request")
        self.assertEqual(Product.objects.get(pk=self.product.pk).name, "当前名称")
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 2)

    def test_apply_restores_only_five_facts_and_never_rewrites_old_revisions(self):
        before_old_rows = list(ProductRevision.objects.filter(product=self.product).order_by("version").values())
        preview_response = self.preview()
        self.assertEqual(preview_response.status_code, 200, preview_response.content)
        response = self.apply(preview_response.json())

        self.assertEqual(response.status_code, 200, response.content)
        result = response.json()
        self.assertEqual(result["status"], "restored")
        self.assertFalse(result["backupCreated"])
        self.assertEqual(result["sourceRevisionId"], self.source.pk)
        self.assertEqual(result["backupRevisionId"], self.current_revision.pk)
        self.assertEqual(result["scope"], SCOPE)
        product = Product.objects.get(pk=self.product.pk)
        self.assertEqual({key: getattr(product, key) for key in SCOPE}, FACTS)
        self.assertEqual((product.sku, product.image_filename, product.image_stored_name), ("SKU-KEEP", "front.png", "stored-front.png"))
        self.assertEqual(product.missing_fields, ["图片"] if not product.image_stored_name else [])
        task = Task.objects.get(pk=self.task.pk)
        self.assertEqual(task.status, "awaiting_confirmation")
        new_revision = ProductRevision.objects.get(pk=result["revision"]["id"])
        self.assertEqual(new_revision.version, 3)
        self.assertEqual(new_revision.status, "needs_review")
        self.assertEqual(new_revision.reviewer, "")
        self.assertEqual(new_revision.source_refs["source"], "product_facts_restore")
        self.assertEqual(new_revision.source_refs["source_revision_id"], self.source.pk)
        self.assertEqual(new_revision.source_refs["backup_revision_id"], self.current_revision.pk)
        self.assertEqual(new_revision.source_refs["scope"], SCOPE)
        after_old_rows = list(ProductRevision.objects.filter(pk__in=[self.source.pk, self.current_revision.pk]).order_by("version").values())
        self.assertEqual(after_old_rows, before_old_rows)

    def test_unsynced_live_facts_get_a_complete_backup_before_restore(self):
        self.product.name = "Unversioned live edit"
        self.product.updated_at = timezone.now()
        self.product.save(update_fields=["name", "updated_at"])
        preview = self.preview()
        self.assertEqual(preview.status_code, 200, preview.content)
        self.assertTrue(preview.json()["wouldCreateBackup"])

        response = self.apply(preview.json())
        self.assertEqual(response.status_code, 200, response.content)
        result = response.json()
        self.assertTrue(result["backupCreated"])
        backup = ProductRevision.objects.get(pk=result["backupRevisionId"])
        restored = ProductRevision.objects.get(pk=result["revision"]["id"])
        self.assertEqual(backup.version, 3)
        self.assertEqual(backup.snapshot["name"], "Unversioned live edit")
        self.assertEqual(backup.snapshot["sku"], "SKU-KEEP")
        self.assertEqual(backup.snapshot["image_filename"], "front.png")
        self.assertEqual(backup.source_refs["source"], "product_facts_restore_backup")
        self.assertEqual(restored.version, 4)
        self.assertEqual(restored.source_refs["backup_revision_id"], backup.pk)
        self.assertEqual(restored.snapshot["name"], FACTS["name"])

    def test_noop_does_not_append_revision_or_change_confirmation_state(self):
        self.product.name = FACTS["name"]
        for field in SCOPE:
            setattr(self.product, field, FACTS[field])
        self.product.updated_at = timezone.now()
        self.product.save(update_fields=[*SCOPE, "updated_at"])
        latest = self.make_revision(3, self.live_facts(), status="confirmed", reviewer="kept reviewer")
        before_count = ProductRevision.objects.filter(product=self.product).count()

        preview = self.preview().json()
        self.assertTrue(preview["noOp"])
        response = self.apply(preview)

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["status"], "no_op")
        self.assertEqual(response.json()["revision"]["id"], latest.pk)
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), before_count)
        self.assertEqual(Task.objects.get(pk=self.task.pk).status, "confirmed")
        self.assertEqual(ProductRevision.objects.get(pk=latest.pk).reviewer, "kept reviewer")

    def test_noop_does_not_mislabel_unsynced_latest_as_backup(self):
        Product.objects.filter(pk=self.product.pk).update(sku="UNSYNCED-SKU")
        before_count = ProductRevision.objects.filter(product=self.product).count()
        preview = self.preview(source=self.current_revision.pk).json()
        self.assertTrue(preview["noOp"])
        self.assertTrue(preview["wouldCreateBackup"])
        response = self.apply(preview, source=self.current_revision.pk)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["status"], "no_op")
        self.assertIsNone(response.json()["backupRevisionId"])
        self.assertFalse(response.json()["backupCreated"])
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), before_count)
        self.assertEqual(Product.objects.get(pk=self.product.pk).sku, "UNSYNCED-SKU")
        self.assertEqual(ProductRevision.objects.get(pk=self.current_revision.pk).reviewer, "current reviewer")

    def test_live_latest_review_source_and_foreign_source_changes_are_rejected(self):
        stale_methods = [
            ("live", lambda: Product.objects.filter(pk=self.product.pk).update(name="Late live edit")),
            ("latest status", lambda: ProductRevision.objects.filter(pk=self.current_revision.pk).update(status="draft", reviewer="")),
            ("task status", lambda: Task.objects.filter(pk=self.task.pk).update(status="awaiting_confirmation")),
        ]
        for label, mutate in stale_methods:
            with self.subTest(label=label):
                # Each case starts with a fresh product/preview so the stale condition is isolated.
                fixture = self._fresh_fixture()
                preview = fixture.preview().json()
                mutate_fixture = {
                    "live": lambda: Product.objects.filter(pk=fixture.product.pk).update(name="Late live edit"),
                    "latest status": lambda: ProductRevision.objects.filter(pk=fixture.current_revision.pk).update(status="draft", reviewer=""),
                    "task status": lambda: Task.objects.filter(pk=fixture.task.pk).update(status="awaiting_confirmation"),
                }[label]
                mutate_fixture()
                response = fixture.apply(preview)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["code"], "restore_preview_stale")
                self.assertEqual(ProductRevision.objects.filter(product=fixture.product).count(), 2)

        other = self._fresh_fixture()
        preview = other.preview(source=other.source.pk).json()
        wrong = other.request(other.client, "POST", f"/api/products/{other.product.pk}/fact-restoration/preview",
                              {"sourceRevisionId": self.source.pk})
        self.assertEqual(wrong.status_code, 404)
        self.assertEqual(wrong.json()["code"], "source_revision_not_found")

    def test_backup_or_restore_revision_write_failure_rolls_back_product_task_and_backup(self):
        self.product.name = "Unversioned live edit"
        self.product.save(update_fields=["name", "updated_at"])
        preview = self.preview().json()
        before_product = Product.objects.get(pk=self.product.pk)
        before_task = Task.objects.get(pk=self.task.pk)
        before_revisions = list(ProductRevision.objects.filter(product=self.product).order_by("version").values())
        original_save = ProductRevision.save

        def fail_restored_revision(revision, *args, **kwargs):
            if revision.source_refs.get("source") == "product_facts_restore":
                raise RuntimeError("fixture restore write failure")
            return original_save(revision, *args, **kwargs)

        with patch.object(ProductRevision, "save", fail_restored_revision):
            response = self.apply(preview)

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["code"], "restore_failed")
        self.assertEqual(Product.objects.get(pk=self.product.pk), before_product)
        self.assertEqual(Task.objects.get(pk=self.task.pk), before_task)
        self.assertEqual(list(ProductRevision.objects.filter(product=self.product).order_by("version").values()), before_revisions)

    def test_concurrent_apply_of_one_preview_has_one_winner(self):
        preview = self.preview().json()
        barrier = threading.Barrier(2)

        def apply_once():
            close_old_connections()
            client = Client()
            try:
                barrier.wait(timeout=10)
                response = self.apply(preview, client=client)
                return response.status_code, response.json().get("code")
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: apply_once(), range(2)))
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        self.assertEqual(ProductRevision.objects.filter(product=self.product).count(), 3)
        self.assertEqual(Product.objects.get(pk=self.product.pk).name, FACTS["name"])

    def _fresh_fixture(self):
        # Separate rows keep stale-CAS subcases independent within one PG test.
        clone = object.__new__(ProductFactRestorationApiTests)
        clone.bridge_key = self.bridge_key
        clone.client = Client()
        now = timezone.now()
        clone.task = Task.objects.create(id=uuid.uuid4().hex, title="Fresh test", mode="csv", status="confirmed", created_at=now, updated_at=now)
        clone.product = Product.objects.create(id=uuid.uuid4().hex, task=clone.task, position=0, sku="KEEP", name="Live", category="Live", material="Live", size="Live", color="Live", image_filename="", image_stored_name="", missing_fields=["图片"], created_at=now, updated_at=now)
        clone.source = ProductRevision.objects.create(id=uuid.uuid4().hex, product=clone.product, version=1,
            snapshot={"sku": "KEEP", "name": FACTS["name"], "category": FACTS["category"], "material": FACTS["material"], "size": FACTS["size"], "color": FACTS["color"], "image_filename": ""},
            field_sources={}, status="confirmed", source_refs={"source": "fixture"}, reviewer="old")
        clone.current_revision = ProductRevision.objects.create(id=uuid.uuid4().hex, product=clone.product, version=2,
            snapshot={"sku": "KEEP", "name": "Live", "category": "Live", "material": "Live", "size": "Live", "color": "Live", "image_filename": ""},
            field_sources={}, status="confirmed", source_refs={"source": "fixture"}, reviewer="current")
        clone.preview_url = f"/api/products/{clone.product.pk}/fact-restoration/preview"
        clone.apply_url = f"/api/products/{clone.product.pk}/fact-restoration/apply"
        clone.preview = lambda **kwargs: ProductFactRestorationApiTests.preview(clone, **kwargs)
        clone.apply = lambda preview, **kwargs: ProductFactRestorationApiTests.apply(clone, preview, **kwargs)
        clone.request = lambda client, method, url, payload=None, **kwargs: ProductFactRestorationApiTests.request(clone, client, method, url, payload, **kwargs)
        return clone
