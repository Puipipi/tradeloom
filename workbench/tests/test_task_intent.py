from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import Client, TestCase
from django.utils import timezone

from workbench.models import Task, WorkflowStep, WorkflowTask


class TaskIntentPreviewTests(TestCase):
    def setUp(self):
        self.batch = Task.objects.create(
            title="Intent fixture", mode="demo", status="confirmed",
            created_at=timezone.now(), updated_at=timezone.now(),
        )

    def post(self, url, payload):
        return Client().post(url, data=json.dumps(payload), content_type="application/json")

    def test_ready_preview_is_structured_and_has_no_business_side_effects(self):
        before = (WorkflowTask.objects.count(), WorkflowStep.objects.count())
        with patch("workbench.agents.context._TOOL_DEFINITIONS") as handlers:
            response = self.post("/api/workflow-intent/preview", {
                "batch_id": self.batch.id,
                "user_goal": "整理产品资料并生成英文目录",
            })
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["mode"], "local_mock")
        self.assertEqual(body["classification"]["task_type"], "generate_deliverables")
        self.assertEqual(body["action"]["task_type"], "generate_deliverables")
        self.assertTrue(body["evidence"])
        self.assertTrue(body["sources"])
        self.assertRegex(body["rules"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(body["prompt"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(before, (WorkflowTask.objects.count(), WorkflowStep.objects.count()))
        handlers.assert_not_called()
        for goal in (
            "生成英文目录草稿和样品核对清单",
            "整理产品资料并生成英文目录",
        ):
            parsed = self.post("/api/workflow-intent/preview", {
                "batch_id": self.batch.id, "user_goal": goal,
            }).json()
            self.assertEqual(parsed["classification"]["task_type"], "generate_deliverables")

    def test_structured_agent_proposal_previews_and_creates_only_after_confirming_allowlisted_type(self):
        batch_id = self.batch.id
        user_goal = "For this batch, prepare the English catalog and sample checklist."
        before = (WorkflowTask.objects.count(), WorkflowStep.objects.count())

        preview_response = self.post("/api/workflow-intent/preview", {
            "batch_id": batch_id,
            "user_goal": user_goal,
            "task_type": "generate_deliverables",
        })
        self.assertEqual(preview_response.status_code, 200, preview_response.content)
        preview = preview_response.json()
        self.assertEqual(preview["status"], "ready")
        self.assertEqual(preview["action"]["user_goal"], user_goal)
        self.assertEqual(preview["action"]["task_type"], "generate_deliverables")
        self.assertEqual(preview["classification"]["source"], "structured_agent_proposal")
        self.assertEqual(before, (WorkflowTask.objects.count(), WorkflowStep.objects.count()))

        create_payload = {
            "batch_id": batch_id,
            "user_goal": user_goal,
            "task_type": "generate_deliverables",
            "confirmation_token": preview["confirmation_token"],
            "idempotency_key": "structured-proposal-confirm-key",
        }
        created = self.post("/api/workflow-tasks", create_payload)
        self.assertEqual(created.status_code, 201, created.content)
        workflow_id = created.json()["id"]
        workflow = WorkflowTask.objects.get(pk=workflow_id)
        self.assertEqual(workflow.user_goal, user_goal)
        self.assertEqual(workflow.task_type, "generate_deliverables")
        plan = WorkflowStep.objects.get(task_id=workflow_id, step_key="center_plan").output_refs["plan"]
        self.assertEqual(plan["classification"]["task_type"], "generate_deliverables")
        self.assertEqual(plan["classification"]["source"], "confirmed_structured_agent_proposal")

        replay = self.post("/api/workflow-tasks", create_payload)
        self.assertEqual(replay.status_code, 201, replay.content)
        self.assertEqual(replay.json(), created.json())

        for invalid in (
            {"batch_id": batch_id, "user_goal": user_goal, "task_type": "run_arbitrary_tool"},
            {"batch_id": batch_id, "user_goal": user_goal, "task_type": None},
            {"batch_id": batch_id, "user_goal": " ", "task_type": "generate_deliverables"},
        ):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.post("/api/workflow-intent/preview", invalid).status_code, 422)

        tampered_goal = self.post("/api/workflow-tasks", {
            **create_payload,
            "user_goal": user_goal + " changed",
            "idempotency_key": "structured-proposal-tampered-goal",
        })
        tampered_type = self.post("/api/workflow-tasks", {
            **create_payload,
            "task_type": "prepare_product_data",
            "idempotency_key": "structured-proposal-tampered-type",
        })
        unsupported_type = self.post("/api/workflow-tasks", {
            **create_payload,
            "task_type": "run_arbitrary_tool",
            "idempotency_key": "structured-proposal-unsupported-type",
        })
        for response in (tampered_goal, tampered_type, unsupported_type):
            self.assertEqual(response.status_code, 409)

        from workbench.intent import parser

        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary)
            shutil.copy(parser.CONFIG_DIR / "rules.json", copied / "rules.json")
            shutil.copy(parser.CONFIG_DIR / "prompt.md", copied / "prompt.md")
            rules = json.loads((copied / "rules.json").read_text(encoding="utf-8"))
            rules["version"] = "structured-rules-changed"
            (copied / "rules.json").write_text(json.dumps(rules), encoding="utf-8")
            with patch.object(parser, "CONFIG_DIR", copied):
                stale_policy = self.post("/api/workflow-tasks", {
                    **create_payload,
                    "idempotency_key": "structured-proposal-stale-policy",
                })
        self.assertEqual(stale_policy.status_code, 409)

    def test_ambiguous_unknown_negated_and_out_of_scope_goals_do_not_become_ready(self):
        goals = (
            "帮我处理一下",
            "准备报价并生成目录",
            "不要生成目录",
            "不生成英文目录",
            "不整理产品资料",
            "not generate catalog",
            "联系客户安排付款",
            "整理产品资料并发邮件",
            "整理产品资料并做营销",
            "整理产品资料并审批",
        )
        for goal in goals:
            with self.subTest(goal=goal):
                response = self.post("/api/workflow-intent/preview", {
                    "batch_id": self.batch.id, "user_goal": goal,
                })
                self.assertEqual(response.status_code, 200)
                self.assertNotEqual(response.json()["status"], "ready")

    def test_preview_strict_fields_types_lengths_and_batch(self):
        valid = {"batch_id": self.batch.id, "user_goal": "整理产品资料"}
        for payload in (
            {**valid, "extra": True},
            {"batch_id": 1, "user_goal": "整理产品资料"},
            {"batch_id": self.batch.id, "user_goal": " "},
            {"batch_id": self.batch.id, "user_goal": "x" * 4001},
        ):
            with self.subTest(payload=payload):
                self.assertEqual(self.post("/api/workflow-intent/preview", payload).status_code, 422)
        self.assertEqual(self.post("/api/workflow-intent/preview", {
            "batch_id": "missing-batch", "user_goal": "整理产品资料",
        }).status_code, 404)

    def test_invalid_rule_configuration_fails_closed(self):
        from workbench.intent.parser import IntentConfigurationError

        with patch("workbench.intent.parser.load_intent_config", side_effect=IntentConfigurationError("invalid rules")):
            response = self.post("/api/workflow-intent/preview", {
                "batch_id": self.batch.id, "user_goal": "整理产品资料",
            })
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "intent_config_invalid")

    def test_confirmation_token_is_bound_to_raw_request_and_policy(self):
        preview = self.post("/api/workflow-intent/preview", {
            "batch_id": self.batch.id, "user_goal": "整理本批产品资料",
        }).json()
        token = preview["confirmation_token"]
        payload = {
            "batch_id": self.batch.id,
            "user_goal": "整理本批产品资料",
            "task_type": "prepare_product_data",
            "confirmation_token": token,
            "idempotency_key": "intent-confirm-key",
        }
        ok = self.post("/api/workflow-tasks", payload)
        self.assertEqual(ok.status_code, 201)
        workflow_id = ok.json()["id"]
        plan = WorkflowStep.objects.get(task_id=workflow_id, step_key="center_plan").output_refs["plan"]
        self.assertEqual(plan["classification"]["task_type"], "prepare_product_data")
        self.assertEqual(plan["classification"]["source"], "confirmed_natural_language_intent")
        self.assertEqual(plan["classification"]["evidence"], preview["evidence"])
        restored = self.client.get(f"/api/workflow-tasks/{workflow_id}").json()
        self.assertEqual(
            restored["steps"][0]["output_refs"]["plan"]["classification"]["task_type"],
            "prepare_product_data",
        )

        changed_goal = self.post("/api/workflow-tasks", {**payload, "user_goal": " 整理本批产品资料"})
        changed_type = self.post("/api/workflow-tasks", {**payload, "task_type": "generate_deliverables"})
        changed_batch = self.post("/api/workflow-tasks", {**payload, "batch_id": "other-batch"})
        for response in (changed_goal, changed_type, changed_batch):
            self.assertEqual(response.status_code, 409)
        invalid_token = self.post("/api/workflow-tasks", {
            **payload,
            "idempotency_key": "different-intent-key",
            "confirmation_token": token[:-1] + ("a" if token[-1] != "a" else "b"),
        })
        self.assertEqual(invalid_token.status_code, 409)
        changed_goal_new_key = self.post("/api/workflow-tasks", {
            **payload, "idempotency_key": "different-goal-key",
            "user_goal": "整理本批产品资料 ",
        })
        changed_type_new_key = self.post("/api/workflow-tasks", {
            **payload, "idempotency_key": "different-type-key",
            "task_type": "generate_deliverables",
        })
        self.assertEqual(changed_goal_new_key.status_code, 409)
        self.assertEqual(changed_type_new_key.status_code, 409)

        from workbench.intent import parser

        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary)
            shutil.copy(parser.CONFIG_DIR / "rules.json", copied / "rules.json")
            shutil.copy(parser.CONFIG_DIR / "prompt.md", copied / "prompt.md")
            (copied / "prompt.md").write_text(
                (copied / "prompt.md").read_text(encoding="utf-8") + "\nChanged prompt.\n",
                encoding="utf-8",
            )
            with patch.object(parser, "CONFIG_DIR", copied):
                stale_policy = self.post("/api/workflow-tasks", {
                    **payload, "idempotency_key": "stale-policy-key",
                })
        self.assertEqual(stale_policy.status_code, 409)

    def test_frozen_receipt_replays_before_current_token_or_policy_validation(self):
        preview = self.post("/api/workflow-intent/preview", {
            "batch_id": self.batch.id, "user_goal": "整理产品资料",
        }).json()
        payload = {
            "batch_id": self.batch.id, "user_goal": "整理产品资料",
            "task_type": "prepare_product_data",
            "confirmation_token": preview["confirmation_token"],
            "idempotency_key": "intent-replay-key",
        }
        first = self.post("/api/workflow-tasks", payload)
        self.assertEqual(first.status_code, 201)
        with patch("workbench.intent.parser.load_intent_config", side_effect=ValueError("policy changed")):
            replay = self.post("/api/workflow-tasks", payload)
        self.assertEqual(replay.status_code, 201)
        self.assertEqual(replay.json(), first.json())

    def test_prompt_and_rule_hashes_track_content_and_schema_errors_fail(self):
        from workbench.intent import parser

        config = parser.load_intent_config()
        self.assertRegex(config["rules_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(config["prompt_sha256"], r"^[0-9a-f]{64}$")
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary)
            shutil.copy(parser.CONFIG_DIR / "rules.json", copied / "rules.json")
            shutil.copy(parser.CONFIG_DIR / "prompt.md", copied / "prompt.md")
            with patch.object(parser, "CONFIG_DIR", copied):
                initial = parser.load_intent_config()
                (copied / "prompt.md").write_text(
                    (copied / "prompt.md").read_text(encoding="utf-8") + "\nEdit.\n",
                    encoding="utf-8",
                )
                changed_prompt = parser.load_intent_config()
                self.assertNotEqual(initial["prompt_sha256"], changed_prompt["prompt_sha256"])
                rules = json.loads((copied / "rules.json").read_text(encoding="utf-8"))
                rules["version"] = "task-intent-rules-test-change"
                (copied / "rules.json").write_text(json.dumps(rules), encoding="utf-8")
                changed_rules = parser.load_intent_config()
                self.assertNotEqual(initial["rules_sha256"], changed_rules["rules_sha256"])
                (copied / "rules.json").write_text("{}", encoding="utf-8")
                with self.assertRaises(parser.IntentConfigurationError):
                    parser.load_intent_config()

