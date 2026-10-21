from __future__ import annotations

import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.db import DatabaseError
from django.test import TestCase, override_settings

from workbench.models import AgentRun, Product, Task, TaskFile
from workbench.services import WorkbenchService


@override_settings(MEDIA_ROOT=Path(tempfile.mkdtemp(prefix="tradeloom-test-")))
class WorkbenchApiTests(TestCase):
    def test_demo_confirm_export_flow(self):
        task = self.client.post("/api/tasks/demo").json()
        self.assertEqual(task["status"], "awaiting_confirmation")
        self.assertEqual(
            task["products"][1]["missing_fields"],
            ["材质"],
        )
        blocked = self.client.post(f"/api/tasks/{task['id']}/confirm")
        self.assertEqual(blocked.status_code, 409)
        export_blocked = self.client.get(f"/api/tasks/{task['id']}/export.csv")
        self.assertEqual(export_blocked.status_code, 409)

        product = task["products"][1]
        updated = self.client.patch(
            f"/api/products/{product['id']}",
            data=json.dumps({"material": "缎面织物"}),
            content_type="application/json",
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["missing_fields"], [])
        confirmed = self.client.post(f"/api/tasks/{task['id']}/confirm")
        self.assertEqual(confirmed.status_code, 200)
        self.assertEqual(confirmed.json()["status"], "confirmed")
        exported = self.client.get(f"/api/tasks/{task['id']}/export.csv")
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(
            exported["Content-Disposition"],
            'attachment; filename="products.csv"',
        )
        text = exported.content.decode("utf-8")
        self.assertTrue(text.startswith("sku,name,category,material,size,color,image_filename\n"))
        self.assertIn(
            "DEMO-002,装饰蝴蝶结 香槟金,蝴蝶结,缎面织物,8cm,香槟金,DEMO-002.svg",
            text,
        )
        edited_again = self.client.patch(
            f"/api/products/{product['id']}",
            data=json.dumps({"material": "缎面织物更新"}),
            content_type="application/json",
        )
        self.assertEqual(edited_again.status_code, 200)
        self.assertEqual(
            self.client.get(f"/api/tasks/{task['id']}").json()["status"],
            "awaiting_confirmation",
        )
        self.assertEqual(
            self.client.get(f"/api/tasks/{task['id']}/export.csv").status_code,
            409,
        )

    def test_image_filename_derived_and_sku_rematch(self):
        task = self.client.post("/api/tasks/demo").json()
        product = next(item for item in task["products"] if item["sku"] == "DEMO-001")
        rejected = self.client.patch(
            f"/api/products/{product['id']}",
            data=json.dumps({"image_filename": "wrong.svg"}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 422)
        changed = self.client.patch(
            f"/api/products/{product['id']}",
            data=json.dumps({"sku": "UNMATCHED-001"}),
            content_type="application/json",
        )
        self.assertEqual(changed.status_code, 200)
        self.assertIsNone(changed.json()["image_url"])
        self.assertEqual(changed.json()["image_filename"], "")
        self.assertIn("图片", changed.json()["missing_fields"])
        restored = self.client.patch(
            f"/api/products/{product['id']}",
            data=json.dumps({"sku": "DEMO-001"}),
            content_type="application/json",
        )
        self.assertEqual(restored.json()["image_filename"], "DEMO-001.svg")

    def test_upload_and_file_references(self):
        csv_content = (
            "sku,name,category,material,size,color,image_filename\n"
            "UP-001,罗纹丝带样品,丝带,涤纶,25mm,酒红,UP-001.png\n"
        )
        csv_file = io.BytesIO(csv_content.encode("utf-8-sig"))
        csv_file.name = "products.csv"
        image = io.BytesIO(b"not-an-image")
        image.name = "UP-001-extra.png"
        response = self.client.post(
            "/api/tasks",
            {
                "title": "上传测试",
                "products_csv": csv_file,
                "images": [image],
            },
        )
        self.assertEqual(response.status_code, 200)
        task = response.json()
        self.assertEqual(task["products"][0]["image_filename"], "")
        self.assertIn("图片", task["products"][0]["missing_fields"])
        self.assertEqual({item["kind"] for item in task["files"]}, {"source_csv", "image"})

    def test_run_history(self):
        task = self.client.post("/api/tasks/demo").json()
        dispatched = self.client.post(
            f"/api/tasks/{task['id']}/agents/product_profile"
        )
        self.assertEqual(dispatched.status_code, 200)
        runs = self.client.get(f"/api/tasks/{task['id']}/runs").json()
        self.assertEqual(runs[0]["capability_id"], "product_profile")
        self.assertEqual(runs[0]["status"], "needs_confirmation")
        unavailable = self.client.post(
            f"/api/tasks/{task['id']}/agents/quotation"
        )
        self.assertEqual(unavailable.status_code, 409)
        runs = self.client.get(f"/api/tasks/{task['id']}/runs").json()
        self.assertEqual(runs[0]["status"], "unavailable")

    def test_agent_idempotency_key_replays_same_run_and_new_keys_create_runs(self):
        task = self.client.post("/api/tasks/demo").json()
        url = f"/api/tasks/{task['id']}/agents/product_profile"
        headers = {"HTTP_IDEMPOTENCY_KEY": "click-1"}

        first = self.client.post(url, **headers)
        replay = self.client.post(url, **headers)
        second_click = self.client.post(url, HTTP_IDEMPOTENCY_KEY="click-2")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first.json(), replay.json())
        self.assertEqual(first.json()["run_id"], replay.json()["run_id"])
        self.assertNotEqual(first.json()["run_id"], second_click.json()["run_id"])
        self.assertEqual(AgentRun.objects.filter(task_id=task["id"]).count(), 2)

    def test_agent_idempotency_is_scoped_to_task_and_capability(self):
        task_a = self.client.post("/api/tasks/demo").json()
        task_b = self.client.post("/api/tasks/demo").json()
        a = self.client.post(
            f"/api/tasks/{task_a['id']}/agents/product_profile",
            HTTP_IDEMPOTENCY_KEY="same-key",
        )
        b = self.client.post(
            f"/api/tasks/{task_b['id']}/agents/product_profile",
            HTTP_IDEMPOTENCY_KEY="same-key",
        )
        other_cap = self.client.post(
            f"/api/tasks/{task_a['id']}/agents/quotation",
            HTTP_IDEMPOTENCY_KEY="same-key",
        )
        self.assertNotEqual(a.json()["run_id"], b.json()["run_id"])
        self.assertEqual(other_cap.status_code, 409)
        self.assertEqual(AgentRun.objects.filter(task_id=task_a["id"]).count(), 2)

    def test_idempotent_replay_ignores_changed_task_facts(self):
        task = self.client.post("/api/tasks/demo").json()
        url = f"/api/tasks/{task['id']}/agents/product_profile"
        first = self.client.post(url, HTTP_IDEMPOTENCY_KEY="stable")
        product = task["products"][0]
        self.client.patch(
            f"/api/products/{product['id']}",
            data=json.dumps({"name": "后来修改"}),
            content_type="application/json",
        )
        replay = self.client.post(url, HTTP_IDEMPOTENCY_KEY="stable")
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json(), first.json())
        self.assertEqual(AgentRun.objects.filter(task_id=task["id"]).count(), 1)

    def test_idempotency_key_is_validated_and_legacy_post_still_creates_runs(self):
        task = self.client.post("/api/tasks/demo").json()
        url = f"/api/tasks/{task['id']}/agents/product_profile"
        invalid = self.client.post(url, HTTP_IDEMPOTENCY_KEY="x" * 201)
        legacy_a = self.client.post(url)
        legacy_b = self.client.post(url)
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(legacy_a.status_code, 200)
        self.assertEqual(legacy_b.status_code, 200)
        self.assertNotEqual(legacy_a.json()["run_id"], legacy_b.json()["run_id"])

    def test_receipt_route_requires_key_and_replays_same_run(self):
        task = self.client.post("/api/tasks/demo").json()
        url = f"/api/tasks/{task['id']}/agents/product_profile/runs"
        missing_key = self.client.post(url)
        self.assertEqual(missing_key.status_code, 400)
        self.assertTrue(missing_key.json()["terminal"])
        self.assertEqual(AgentRun.objects.filter(task_id=task["id"]).count(), 0)

        first = self.client.post(url, HTTP_IDEMPOTENCY_KEY="persisted-key")
        replay = self.client.post(url, HTTP_IDEMPOTENCY_KEY="persisted-key")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first.json(), replay.json())
        self.assertEqual(AgentRun.objects.filter(task_id=task["id"]).count(), 1)

    def test_unavailable_result_replays_as_terminal_error(self):
        task = self.client.post("/api/tasks/demo").json()
        url = f"/api/tasks/{task['id']}/agents/quotation/runs"
        first = self.client.post(url, HTTP_IDEMPOTENCY_KEY="unavailable")
        replay = self.client.post(url, HTTP_IDEMPOTENCY_KEY="unavailable")
        self.assertEqual(first.status_code, 409)
        self.assertEqual(replay.status_code, 409)
        self.assertTrue(first.json()["terminal"])
        self.assertEqual(first.json(), replay.json())
        self.assertEqual(AgentRun.objects.filter(task_id=task["id"]).count(), 1)

    def test_failed_result_replays_without_dispatching_again(self):
        task = self.client.post("/api/tasks/demo").json()
        calls = []

        class Registry:
            def dispatch(self, _request):
                calls.append(1)
                raise RuntimeError("internal provider text")

        url = f"/api/tasks/{task['id']}/agents/product_profile/runs"
        with patch("workbench.services.build_default_registry", return_value=Registry()):
            first = self.client.post(url, HTTP_IDEMPOTENCY_KEY="failed-once")
            replay = self.client.post(url, HTTP_IDEMPOTENCY_KEY="failed-once")
        self.assertEqual(first.status_code, 500)
        self.assertEqual(replay.status_code, 500)
        self.assertTrue(first.json()["terminal"])
        self.assertEqual(first.json(), replay.json())
        self.assertEqual(calls, [1])
        run = AgentRun.objects.get(task_id=task["id"])
        self.assertEqual(run.status, "failed")

    def test_failure_write_error_keeps_receipt_unknown_and_does_not_dispatch_again(self):
        task = self.client.post("/api/tasks/demo").json()
        calls = []

        class Registry:
            def dispatch(self, _request):
                calls.append(1)
                raise RuntimeError("dispatch failed")

        original_save = AgentRun.save

        def fail_failed_run_save(instance, *args, **kwargs):
            if instance.status == "failed":
                raise DatabaseError("simulated terminal save failure")
            return original_save(instance, *args, **kwargs)

        url = f"/api/tasks/{task['id']}/agents/product_profile/runs"
        with (
            patch("workbench.services.build_default_registry", return_value=Registry()),
            patch.object(AgentRun, "save", fail_failed_run_save),
        ):
            first = self.client.post(url, HTTP_IDEMPOTENCY_KEY="unknown-save")
            replay = self.client.post(url, HTTP_IDEMPOTENCY_KEY="unknown-save")
        self.assertEqual(first.status_code, 500)
        self.assertFalse(first.json()["terminal"])
        self.assertEqual(replay.status_code, 202)
        self.assertEqual(replay.json()["status"], "running")
        self.assertEqual(calls, [1])
        self.assertEqual(AgentRun.objects.get(task_id=task["id"]).status, "running")

    def test_unexpected_dispatch_error_marks_run_failed(self):
        task = self.client.post("/api/tasks/demo").json()
        service = WorkbenchService()
        original = service.registry.dispatch

        def explode(_request):
            raise RuntimeError("unexpected registry failure")

        service.registry.dispatch = explode
        with self.assertRaises(RuntimeError):
            service.dispatch_agent(task["id"], "product_profile")
        run = AgentRun.objects.filter(task_id=task["id"]).latest("started_at")
        self.assertEqual(run.status, "failed")
        self.assertIn("unexpected registry failure", run.error)
        self.assertIsNotNone(run.finished_at)

    def test_model_ids_and_ordering_are_preserved(self):
        task = Task.objects.create(
            title="排序",
            mode="upload",
            status="awaiting_confirmation",
            created_at="2026-10-18T00:00:00+00:00",
            updated_at="2026-10-18T00:00:00+00:00",
        )
        for index in [2, 0, 1]:
            Product.objects.create(
                task=task,
                position=index,
                sku=f"SKU-{index}",
                name="",
                category="",
                material="",
                size="",
                color="",
                image_filename="",
                missing_fields=["货号"],
                created_at=task.created_at,
                updated_at=task.updated_at,
            )
        self.assertEqual(
            list(task.products.values_list("sku", flat=True)),
            ["SKU-0", "SKU-1", "SKU-2"],
        )
