from __future__ import annotations

import io
import json
import tempfile
from pathlib import Path

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from workbench.models import Product, ProductRevision, Task, TaskFile
from workbench.products.versions import (
    backfill_legacy_product_revisions,
    confirm_batch_revisions,
    sync_revision_from_product,
)
from workbench.services import WorkbenchService


LEGACY_FACT_FIELDS = (
    "sku",
    "name",
    "category",
    "material",
    "size",
    "color",
    "image_filename",
)


def legacy_snapshot(product: Product) -> dict[str, str]:
    return {field: getattr(product, field) for field in LEGACY_FACT_FIELDS}


def upload_file(name: str, content: bytes = b"image-bytes"):
    handle = io.BytesIO(content)
    handle.name = name
    return handle


@override_settings(MEDIA_ROOT=Path(tempfile.mkdtemp(prefix="tradeloom-task3-")))
class LegacyCompatibilityTests(TestCase):
    def make_batch(self, *, status: str = "awaiting_confirmation") -> Task:
        now = timezone.now()
        return Task.objects.create(
            title="legacy 兼容测试",
            mode="upload",
            status=status,
            created_at=now,
            updated_at=now,
        )

    def make_product(
        self,
        batch: Task,
        *,
        sku: str,
        position: int = 0,
        material: str = "涤纶",
        image_filename: str = "",
        image_stored_name: str = "",
        missing_fields: list[str] | None = None,
    ) -> Product:
        now = timezone.now()
        return Product.objects.create(
            task=batch,
            position=position,
            sku=sku,
            name="罗纹丝带",
            category="丝带",
            material=material,
            size="25mm",
            color="酒红",
            image_filename=image_filename,
            image_stored_name=image_stored_name,
            missing_fields=[] if missing_fields is None else missing_fields,
            created_at=now,
            updated_at=now,
        )

    def make_image_file(
        self,
        batch: Task,
        *,
        original_name: str,
        stored_name: str,
    ) -> TaskFile:
        return TaskFile.objects.create(
            task=batch,
            kind="image",
            original_name=original_name,
            stored_name=stored_name,
            created_at=timezone.now(),
        )

    def upload_csv(self, rows, images=()):
        lines = ["sku,name,category,material,size,color,image_filename"]
        lines.extend(",".join(row) for row in rows)
        csv_file = upload_file(
            "products.csv",
            ("\n".join(lines) + "\n").encode("utf-8-sig"),
        )
        data = {
            "title": "legacy 同步测试",
            "products_csv": csv_file,
        }
        if images:
            data["images"] = [
                upload_file(name, content) for name, content in images
            ]
        return self.client.post("/api/tasks", data)

    def make_legacy_product(
        self,
        batch: Task,
        *,
        sku: str,
        position: int = 0,
        with_image: bool = False,
    ) -> tuple[Product, TaskFile | None]:
        image_filename = ""
        image_stored_name = ""
        image_file = None
        if with_image:
            image_filename = f"{sku}.svg"
            image_stored_name = f"stored-{sku}.svg"
            image_file = self.make_image_file(
                batch,
                original_name=image_filename,
                stored_name=image_stored_name,
            )
        product = self.make_product(
            batch,
            sku=sku,
            position=position,
            image_filename=image_filename,
            image_stored_name=image_stored_name,
        )
        return product, image_file

    def test_csv_creation_creates_v1_for_each_product_with_image_source(self):
        response = self.upload_csv(
            [
                ("SKU-1", "罗纹丝带", "丝带", "涤纶", "25mm", "酒红", "SKU-1.png"),
                ("SKU-2", "装饰蝴蝶结", "蝴蝶结", "", "8cm", "香槟金", ""),
            ],
            images=[("SKU-1.png", b"image-bytes")],
        )

        self.assertEqual(response.status_code, 200)
        task = Task.objects.get(id=response.json()["id"])
        self.assertEqual(task.status, "awaiting_confirmation")
        products = list(task.products.order_by("position"))
        self.assertEqual(len(products), 2)

        for product in products:
            self.assertEqual(product.revisions.count(), 1)
            revision = product.revisions.get()
            self.assertEqual(revision.version, 1)
            self.assertEqual(revision.status, "needs_review")
            self.assertEqual(revision.snapshot, legacy_snapshot(product))
            self.assertEqual(revision.source_refs["source"], "legacy_csv")

        first = products[0]
        image_file = TaskFile.objects.get(
            task=task,
            stored_name=first.image_stored_name,
        )
        image_ref = first.revisions.get().source_refs["image"]
        self.assertEqual(image_ref["task_file_id"], image_file.id)
        self.assertEqual(image_ref["stored_name"], image_file.stored_name)
        self.assertEqual(image_ref["original_name"], "SKU-1.png")
        self.assertNotIn("image", products[1].revisions.get().source_refs)

    def test_patch_changed_fact_appends_versions_and_preserves_old_snapshots(self):
        response = self.upload_csv(
            [("SKU-1", "罗纹丝带", "丝带", "涤纶", "25mm", "酒红", "SKU-1.png")],
            images=[("SKU-1.png", b"image-bytes")],
        )
        task_id = response.json()["id"]
        product = Task.objects.get(id=task_id).products.get()
        self.assertEqual(self.client.post(f"/api/tasks/{task_id}/confirm").status_code, 200)

        v1 = product.revisions.get(version=1)
        v1_snapshot = dict(v1.snapshot)
        self.assertEqual(v1.status, "confirmed")

        first_patch = self.client.patch(
            f"/api/products/{product.id}",
            data=json.dumps({"material": "缎面织物"}),
            content_type="application/json",
        )
        self.assertEqual(first_patch.status_code, 200)

        versions = list(product.revisions.order_by("version"))
        self.assertEqual([item.version for item in versions], [1, 2])
        self.assertEqual(versions[0].snapshot, v1_snapshot)
        self.assertEqual(versions[0].status, "confirmed")
        self.assertEqual(versions[1].status, "needs_review")
        self.assertEqual(versions[1].snapshot["material"], "缎面织物")
        self.assertEqual(
            versions[1].source_refs["image"]["stored_name"],
            product.image_stored_name,
        )

        second_patch = self.client.patch(
            f"/api/products/{product.id}",
            data=json.dumps({"material": "缎面织物更新"}),
            content_type="application/json",
        )
        self.assertEqual(second_patch.status_code, 200)
        versions = list(product.revisions.order_by("version"))
        self.assertEqual([item.version for item in versions], [1, 2, 3])
        self.assertEqual(versions[1].snapshot["material"], "缎面织物")
        self.assertEqual(versions[0].snapshot, v1_snapshot)
        task = Task.objects.get(id=task_id)
        self.assertEqual(task.status, "awaiting_confirmation")

    def test_patch_without_fact_change_reuses_revision_and_syncs_status(self):
        response = self.upload_csv(
            [("SKU-1", "罗纹丝带", "丝带", "涤纶", "25mm", "酒红", "SKU-1.png")],
            images=[("SKU-1.png", b"image-bytes")],
        )
        task_id = response.json()["id"]
        product = Task.objects.get(id=task_id).products.get()
        self.assertEqual(self.client.post(f"/api/tasks/{task_id}/confirm").status_code, 200)

        revision = product.revisions.get()
        snapshot = dict(revision.snapshot)
        response = self.client.patch(
            f"/api/products/{product.id}",
            data=json.dumps({"material": "涤纶"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(product.revisions.count(), 1)
        revision.refresh_from_db()
        self.assertEqual(revision.snapshot, snapshot)
        self.assertEqual(revision.status, "needs_review")
        self.assertEqual(revision.reviewer, "")
        task = Task.objects.get(id=task_id)
        self.assertEqual(task.status, "awaiting_confirmation")

    def test_confirm_refuses_missing_fields_without_confirmed_revisions(self):
        response = self.upload_csv(
            [
                ("SKU-1", "罗纹丝带", "丝带", "涤纶", "25mm", "酒红", "SKU-1.png"),
                ("SKU-2", "装饰蝴蝶结", "蝴蝶结", "", "8cm", "香槟金", ""),
            ],
            images=[("SKU-1.png", b"image-bytes")],
        )
        task_id = response.json()["id"]

        confirmed = self.client.post(f"/api/tasks/{task_id}/confirm")

        self.assertEqual(confirmed.status_code, 409)
        self.assertEqual(Task.objects.get(id=task_id).status, "awaiting_confirmation")
        revisions = ProductRevision.objects.filter(product__task_id=task_id)
        self.assertEqual(revisions.count(), 2)
        self.assertFalse(revisions.filter(status="confirmed").exists())
        self.assertEqual(
            set(revisions.values_list("status", flat=True)),
            {"needs_review"},
        )

    def test_confirm_marks_latest_revisions_confirmed_and_preserves_snapshots(self):
        response = self.upload_csv(
            [
                ("SKU-1", "罗纹丝带", "丝带", "涤纶", "25mm", "酒红", "SKU-1.png"),
                ("SKU-2", "装饰蝴蝶结", "蝴蝶结", "缎面", "8cm", "香槟金", "SKU-2.png"),
            ],
            images=[
                ("SKU-1.png", b"image-one"),
                ("SKU-2.png", b"image-two"),
            ],
        )
        task_id = response.json()["id"]
        products = list(Task.objects.get(id=task_id).products.order_by("position"))
        self.assertEqual(
            self.client.patch(
                f"/api/products/{products[0].id}",
                data=json.dumps({"material": "缎面织物"}),
                content_type="application/json",
            ).status_code,
            200,
        )
        before = {
            product.id: dict(product.revisions.order_by("-version").first().snapshot)
            for product in products
        }

        confirmed = self.client.post(f"/api/tasks/{task_id}/confirm")

        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(Task.objects.get(id=task_id).status, "confirmed")
        for product in products:
            latest = product.revisions.order_by("-version").first()
            self.assertEqual(latest.status, "confirmed")
            self.assertEqual(latest.reviewer, "legacy_api")
            self.assertEqual(latest.snapshot, before[product.id])
        self.assertEqual(
            products[0].revisions.get(version=1).status,
            "needs_review",
        )

    def test_confirm_batch_revisions_confirms_latest_and_creates_missing(self):
        batch = self.make_batch(status="confirmed")
        first = self.make_product(batch, sku="CONF-1")
        second = self.make_product(batch, sku="CONF-2", position=1)
        first_revision = ProductRevision.objects.create(
            product=first,
            version=1,
            snapshot=legacy_snapshot(first),
            status="needs_review",
            source_refs={"source": "legacy_product"},
        )

        revisions = confirm_batch_revisions(batch.id, reviewer="auditor")

        self.assertEqual(len(revisions), 2)
        self.assertEqual({item.status for item in revisions}, {"confirmed"})
        self.assertEqual({item.reviewer for item in revisions}, {"auditor"})
        self.assertEqual(Task.objects.get(id=batch.id).status, "confirmed")
        first_revision.refresh_from_db()
        self.assertEqual(first_revision.status, "confirmed")
        self.assertEqual(second.revisions.get(version=1).status, "confirmed")

    def test_confirm_task_reconciles_already_confirmed_batch(self):
        batch = self.make_batch(status="confirmed")
        product = self.make_product(batch, sku="CONF-3")
        revision = ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot=legacy_snapshot(product),
            status="needs_review",
            source_refs={"source": "legacy_product"},
        )

        result = WorkbenchService().confirm_task(batch.id)

        self.assertEqual(result["status"], "confirmed")
        revision.refresh_from_db()
        self.assertEqual(revision.status, "confirmed")
        self.assertEqual(revision.reviewer, "legacy_api")

    def test_english_name_is_preserved_only_while_facts_are_unchanged(self):
        batch = self.make_batch(status="awaiting_confirmation")
        product = self.make_product(batch, sku="EN-1")
        revision = ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot={
                **legacy_snapshot(product),
                "english_name": "Approved Ribbon",
            },
            status="confirmed",
            reviewer="human",
            source_refs={"source": "human_review"},
        )

        reused = sync_revision_from_product(product, actor="legacy_api")

        self.assertEqual(reused.pk, revision.pk)
        self.assertEqual(product.revisions.count(), 1)
        revision.refresh_from_db()
        self.assertEqual(revision.status, "needs_review")
        self.assertEqual(revision.reviewer, "")
        self.assertEqual(revision.snapshot["english_name"], "Approved Ribbon")

        product.material = "缎面织物"
        product.updated_at = timezone.now()
        product.save()
        changed = sync_revision_from_product(product, actor="legacy_api")

        self.assertEqual(changed.version, 2)
        self.assertEqual(changed.snapshot["material"], "缎面织物")
        self.assertNotIn("english_name", changed.snapshot)
        revision.refresh_from_db()
        self.assertEqual(revision.snapshot["material"], "涤纶")
        self.assertEqual(revision.snapshot["english_name"], "Approved Ribbon")

    def test_same_filename_with_different_image_asset_creates_new_revision(self):
        batch = self.make_batch(status="awaiting_confirmation")
        first_file = self.make_image_file(
            batch,
            original_name="SKU-1.png",
            stored_name="stored-first.png",
        )
        second_file = self.make_image_file(
            batch,
            original_name="SKU-1.png",
            stored_name="stored-second.png",
        )
        product = self.make_product(
            batch,
            sku="SKU-1",
            image_filename="SKU-1.png",
            image_stored_name=first_file.stored_name,
        )
        revision = ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot={
                **legacy_snapshot(product),
                "english_name": "Approved Ribbon",
            },
            status="confirmed",
            reviewer="human",
            source_refs={
                "source": "human_review",
                "image": {
                    "task_file_id": first_file.id,
                    "original_name": first_file.original_name,
                    "stored_name": first_file.stored_name,
                },
            },
        )

        product.image_stored_name = second_file.stored_name
        product.updated_at = timezone.now()
        product.save()
        changed = sync_revision_from_product(product, actor="legacy_api")

        self.assertEqual(product.revisions.count(), 2)
        self.assertEqual(changed.version, 2)
        self.assertEqual(changed.snapshot["image_filename"], "SKU-1.png")
        self.assertNotIn("english_name", changed.snapshot)
        self.assertEqual(
            changed.source_refs["image"]["task_file_id"],
            second_file.id,
        )
        self.assertEqual(
            changed.source_refs["image"]["stored_name"],
            second_file.stored_name,
        )
        revision.refresh_from_db()
        self.assertEqual(
            revision.source_refs["image"]["task_file_id"],
            first_file.id,
        )
        self.assertEqual(revision.snapshot["english_name"], "Approved Ribbon")

    def test_backfill_dry_run_reports_without_writing(self):
        for index, status in enumerate(
            ("confirmed", "awaiting_confirmation", "created")
        ):
            batch = self.make_batch(status=status)
            self.make_product(batch, sku=f"LEGACY-{index}")

        existing_batch = self.make_batch(status="confirmed")
        existing_product = self.make_product(existing_batch, sku="EXISTING")
        existing_revision = ProductRevision.objects.create(
            product=existing_product,
            version=1,
            snapshot={"sentinel": True},
            status="confirmed",
            source_refs={"source": "existing"},
        )
        before_revision_count = ProductRevision.objects.count()
        before_task_updated = {
            item.id: item.updated_at for item in Task.objects.all()
        }
        before_product_updated = {
            item.id: item.updated_at for item in Product.objects.all()
        }

        report = backfill_legacy_product_revisions(dry_run=True)

        self.assertTrue(report.dry_run)
        self.assertEqual(report.scanned, 3)
        self.assertEqual(report.created, 0)
        self.assertEqual(
            report.by_status,
            {"confirmed": 1, "draft": 1, "needs_review": 1},
        )
        self.assertEqual(ProductRevision.objects.count(), before_revision_count)
        existing_revision.refresh_from_db()
        self.assertEqual(existing_revision.snapshot, {"sentinel": True})
        for item in Task.objects.all():
            item.refresh_from_db()
            self.assertEqual(item.updated_at, before_task_updated[item.id])
        for item in Product.objects.all():
            item.refresh_from_db()
            self.assertEqual(item.updated_at, before_product_updated[item.id])

        output = io.StringIO()
        call_command("backfill_product_revisions", dry_run=True, stdout=output)
        self.assertIn("dry-run", output.getvalue())
        self.assertIn("scanned=3", output.getvalue())
        self.assertIn("created=0", output.getvalue())
        self.assertEqual(ProductRevision.objects.count(), before_revision_count)

    def test_backfill_creates_v1_by_task_status_and_is_idempotent(self):
        confirmed_batch = self.make_batch(status="confirmed")
        confirmed_product, _ = self.make_legacy_product(
            confirmed_batch,
            sku="BACKFILL-CONF",
        )
        awaiting_batch = self.make_batch(status="awaiting_confirmation")
        awaiting_product, image_file = self.make_legacy_product(
            awaiting_batch,
            sku="BACKFILL-AWAIT",
            with_image=True,
        )
        created_batch = self.make_batch(status="created")
        created_product, _ = self.make_legacy_product(
            created_batch,
            sku="BACKFILL-DRAFT",
        )
        existing_batch = self.make_batch(status="confirmed")
        existing_product, _ = self.make_legacy_product(
            existing_batch,
            sku="BACKFILL-EXISTING",
        )
        existing_revision = ProductRevision.objects.create(
            product=existing_product,
            version=1,
            snapshot={"sentinel": True},
            status="confirmed",
            source_refs={"source": "existing"},
        )
        before_counts = {
            model.__name__: model.objects.count()
            for model in (Task, Product, TaskFile, ProductRevision)
        }
        before_ids = {
            model.__name__: set(model.objects.values_list("id", flat=True))
            for model in (Task, Product, TaskFile)
        }

        output = io.StringIO()
        call_command("backfill_product_revisions", stdout=output)

        self.assertIn("scanned=3", output.getvalue())
        self.assertIn("created=3", output.getvalue())
        expected_statuses = (
            (confirmed_product, "confirmed"),
            (awaiting_product, "needs_review"),
            (created_product, "draft"),
        )
        for product, expected_status in expected_statuses:
            revision = product.revisions.get()
            self.assertEqual(revision.version, 1)
            self.assertEqual(revision.status, expected_status)
            self.assertEqual(revision.snapshot, legacy_snapshot(product))
            self.assertEqual(revision.source_refs["source"], "legacy_backfill")
            self.assertEqual(
                revision.source_refs["legacy_task_id"],
                product.task_id,
            )

        image_ref = awaiting_product.revisions.get().source_refs["image"]
        self.assertEqual(image_ref["task_file_id"], image_file.id)
        self.assertEqual(image_ref["stored_name"], image_file.stored_name)
        existing_revision.refresh_from_db()
        self.assertEqual(existing_revision.snapshot, {"sentinel": True})
        self.assertEqual(existing_product.revisions.count(), 1)
        self.assertEqual(Task.objects.count(), before_counts["Task"])
        self.assertEqual(Product.objects.count(), before_counts["Product"])
        self.assertEqual(TaskFile.objects.count(), before_counts["TaskFile"])
        self.assertEqual(
            set(Task.objects.values_list("id", flat=True)),
            before_ids["Task"],
        )
        self.assertEqual(
            set(Product.objects.values_list("id", flat=True)),
            before_ids["Product"],
        )
        self.assertEqual(
            set(TaskFile.objects.values_list("id", flat=True)),
            before_ids["TaskFile"],
        )
        self.assertEqual(Task.objects.get(id=confirmed_batch.id).status, "confirmed")
        self.assertEqual(
            Task.objects.get(id=awaiting_batch.id).status,
            "awaiting_confirmation",
        )
        self.assertEqual(Task.objects.get(id=created_batch.id).status, "created")

        revision_count = ProductRevision.objects.count()
        second_output = io.StringIO()
        call_command("backfill_product_revisions", stdout=second_output)
        self.assertIn("scanned=0", second_output.getvalue())
        self.assertIn("created=0", second_output.getvalue())
        self.assertEqual(ProductRevision.objects.count(), revision_count)
