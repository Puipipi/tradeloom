from __future__ import annotations

import json
import tempfile
from pathlib import Path

from django.test import Client, TransactionTestCase, override_settings

from workbench.models import HumanReview, SubTask, WorkflowStep
from workbench.services import WorkbenchService
from workbench.workflows.prepare import create_prepared_workflow


class Task13bDeliveryResumeTests(TransactionTestCase):
    """Exercise the browser-backed facts resume through real demo SVG delivery."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="task13b-delivery-resume-")
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.artifacts = self.root / "artifacts"
        self.media.mkdir()
        self.artifacts.mkdir()
        self.settings = override_settings(
            MEDIA_ROOT=self.media,
            TRADELOOM_ARTIFACT_ROOT=self.artifacts,
        )
        self.settings.enable()
        self.client = Client()

    def tearDown(self):
        self.settings.disable()
        self.temp.cleanup()

    def test_real_demo_review_resume_and_delivery_generation(self):
        demo = self.client.post("/api/tasks/demo")
        self.assertEqual(demo.status_code, 200, demo.content)
        batch_id = demo.json()["id"]
        workflow = create_prepared_workflow(
            batch_id=batch_id,
            user_goal="补全演示商品资料并生成交付文件",
        )

        def dispatch_visible_target():
            page = self.client.get(f"/workflow-tasks/{workflow.id}")
            self.assertEqual(page.status_code, 200, page.content)
            target = page.context["dispatch_target"]
            self.assertIsNotNone(target)
            response = self.client.post(
                target["url"],
                data=json.dumps({"idempotency_key": target["idempotency_key"]}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 200, response.content)
            return page, response

        dispatch_visible_target()  # product_profile: creates real source-backed reviews
        reviews = list(HumanReview.objects.filter(task=workflow).order_by("created_at", "id"))
        self.assertEqual(len(reviews), 5)
        literal_values = {
            "material": "\u6f14\u793a\u6da4\u7eb6\uff08\u4eba\u5de5\u6d4b\u8bd5\uff09",
            "english_name": "DEMO Ribbon 25mm Burgundy",
        }
        for review in reviews:
            refs = review.source_conflict["source_refs"]
            signal = refs["signal"]
            if "missing_field" in signal:
                field = signal["missing_field"]
                answer = {"type": "set_literal_field", "field": field, "value": literal_values[field]}
            else:
                answer = {"type": "confirm_current_revision", "revision_id": refs["revision_id"]}
            submitted = self.client.post(
                f"/api/workflow-tasks/{workflow.id}/reviews/{review.id}/submit",
                data=json.dumps({
                    "review_key": review.review_key,
                    "answer": answer,
                    "reviewer": "task13b-isolated-integration",
                }),
                content_type="application/json",
            )
            self.assertEqual(submitted.status_code, 200, submitted.content)

        applied = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/reviews/apply",
            data=json.dumps({
                "review_ids": [review.id for review in reviews],
                "idempotency_key": "task13b-isolated-apply",
                "decision": "apply_and_confirm",
                "reviewer": "task13b-isolated-integration",
            }),
            content_type="application/json",
        )
        self.assertEqual(applied.status_code, 200, applied.content)

        dispatch_visible_target()  # resumed product_profile
        dispatch_visible_target()  # delivery_quality, only after product completion
        subtask_steps = list(
            WorkflowStep.objects.filter(task=workflow, step_key__startswith="subtask:")
            .order_by("created_at", "id")
        )
        self.assertEqual(len(subtask_steps), 3)
        self.assertEqual(
            {step.input_refs.get("agent_role") for step in subtask_steps},
            {"product_profile", "delivery_quality"},
        )
        self.assertTrue(all(step.status == "completed" for step in subtask_steps))
        self.assertTrue(all(subtask.status == "completed" for subtask in SubTask.objects.filter(task=workflow)))

        generated = self.client.post(
            f"/api/workflow-tasks/{workflow.id}/deliverables",
            data=json.dumps({"idempotency_key": "task13b-isolated-generate"}),
            content_type="application/json",
        )
        self.assertEqual(generated.status_code, 200, generated.content)
        self.assertEqual(generated.json()["status"], "completed")
        self.assertEqual(generated.json()["quality_status"], "passed")
        self.assertEqual(len(generated.json()["artifact_version_ids"]), 5)
