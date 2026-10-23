from __future__ import annotations

import json
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from queue import Queue
from threading import Event, local
from unittest.mock import patch

from django.db import connections
from django.test import Client, TransactionTestCase
from django.utils import timezone

from workbench.models import EventLog, SubTask, Task, WorkflowStep, WorkflowTask
from workbench.intent import parser
from workbench.workflows.prepare import verify_confirmation_token as verify_intent_token
from workbench.workflows.orchestrator import WorkflowOrchestrator


class WorkflowCreateIdempotencyConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def setUp(self):
        now = timezone.now()
        self.batch = Task.objects.create(
            title="Workflow create concurrency fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        self.url = "/api/workflow-tasks"

    def request(self, payload):
        connections.close_all()
        try:
            response = Client().post(
                self.url,
                data=json.dumps(payload),
                content_type="application/json",
            )
            return response.status_code, response.json()
        finally:
            connections.close_all()

    def run_competition(self, second_goal):
        entered_plan = Event()
        release_plan = Event()
        original_plan = WorkflowOrchestrator.plan_task

        def blocked_plan(orchestrator, workflow_id, *args, **kwargs):
            entered_plan.set()
            if not release_plan.wait(5):
                raise TimeoutError("bounded create plan wait expired")
            return original_plan(orchestrator, workflow_id, *args, **kwargs)

        base = {
            "batch_id": self.batch.id,
            "user_goal": "同一目标",
            "task_type": "prepare_product_data",
            "idempotency_key": f"workflow-create-concurrent-{second_goal}",
        }
        second = {**base, "user_goal": second_goal}
        with patch.object(
            WorkflowOrchestrator, "plan_task", autospec=True, side_effect=blocked_plan
        ) as plan:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first_future = pool.submit(self.request, base)
                self.assertTrue(entered_plan.wait(5), "first plan did not enter")
                second_started = Event()

                def second_request():
                    second_started.set()
                    return self.request(second)

                second_future = pool.submit(second_request)
                self.assertTrue(second_started.wait(5), "second request did not start")
                release_plan.set()
                first_result = first_future.result(timeout=8)
                second_result = second_future.result(timeout=8)

        return base, first_result, second_result, plan.call_count

    def test_two_connections_with_same_payload_create_one_complete_plan(self):
        payload, first, second, plan_calls = self.run_competition("同一目标")

        self.assertEqual(first[0], 201)
        self.assertEqual(second[0], 201)
        self.assertEqual(first[1], second[1])
        self.assertEqual(plan_calls, 1)
        workflow = WorkflowTask.objects.get(
            creation_idempotency_key=payload["idempotency_key"]
        )
        self.assertEqual(WorkflowTask.objects.count(), 1)
        self.assertEqual(WorkflowStep.objects.filter(task=workflow).count(), 1)
        self.assertEqual(SubTask.objects.filter(task=workflow).count(), 2)
        self.assertEqual(EventLog.objects.filter(task=workflow).count(), 4)

    def test_two_connections_with_competing_payloads_return_one_conflict(self):
        payload, first, second, plan_calls = self.run_competition("竞争目标")
        responses = [first, second]

        self.assertEqual(sorted(status for status, _ in responses), [201, 409])
        conflict = next(body for status, body in responses if status == 409)
        self.assertEqual(conflict["code"], "idempotency_conflict")
        self.assertEqual(plan_calls, 1)
        workflow = WorkflowTask.objects.get(
            creation_idempotency_key=payload["idempotency_key"]
        )
        self.assertEqual(WorkflowTask.objects.count(), 1)
        self.assertEqual(WorkflowStep.objects.filter(task=workflow).count(), 1)
        self.assertEqual(SubTask.objects.filter(task=workflow).count(), 2)
        self.assertEqual(EventLog.objects.filter(task=workflow).count(), 4)

    def test_confirmed_create_race_replays_receipt_after_policy_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            config_dir = __import__("pathlib").Path(temporary)
            shutil.copy(parser.CONFIG_DIR / "rules.json", config_dir / "rules.json")
            shutil.copy(parser.CONFIG_DIR / "prompt.md", config_dir / "prompt.md")
            with patch.object(parser, "CONFIG_DIR", config_dir):
                preview = Client().post(
                    "/api/workflow-intent/preview",
                    data=json.dumps({"batch_id": self.batch.id, "user_goal": "整理产品资料"}),
                    content_type="application/json",
                ).json()
                payload = {
                    "batch_id": self.batch.id,
                    "user_goal": "整理产品资料",
                    "task_type": "prepare_product_data",
                    "confirmation_token": preview["confirmation_token"],
                    "idempotency_key": "confirmed-workflow-create-race",
                }

                plan_entered = Event()
                release_plan = Event()
                release_competitor = Event()
                stage_queue = Queue()
                thread_context = local()
                original_plan = WorkflowOrchestrator.plan_task
                original_get_or_create = WorkflowTask.objects.get_or_create

                def blocked_plan(orchestrator, workflow_id, **kwargs):
                    plan_entered.set()
                    if not release_plan.wait(5):
                        raise TimeoutError("confirmed create plan wait expired")
                    return original_plan(orchestrator, workflow_id, **kwargs)

                def observed_verify(**kwargs):
                    if getattr(thread_context, "competitor", False):
                        stage_queue.put("verify")
                        if not release_competitor.wait(5):
                            raise TimeoutError("competitor verify gate expired")
                    return verify_intent_token(**kwargs)

                def observed_get_or_create(*args, **kwargs):
                    if getattr(thread_context, "competitor", False):
                        stage_queue.put("insert")
                        if not release_competitor.wait(5):
                            raise TimeoutError("competitor insert gate expired")
                    return original_get_or_create(*args, **kwargs)

                def request(payload):
                    connections.close_all()
                    try:
                        response = Client().post(
                            self.url,
                            data=json.dumps(payload),
                            content_type="application/json",
                        )
                        return response.status_code, response.json()
                    finally:
                        connections.close_all()

                with patch.object(
                    WorkflowOrchestrator, "plan_task", autospec=True,
                    side_effect=blocked_plan,
                ) as plan, patch(
                    "workbench.workflows.prepare.verify_confirmation_token",
                    side_effect=observed_verify,
                ), patch.object(
                    WorkflowTask.objects, "get_or_create", new=observed_get_or_create,
                ):
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        first_future = pool.submit(request, payload)
                        self.assertTrue(plan_entered.wait(5), "first confirmed plan did not enter")

                        def competitor_request():
                            thread_context.competitor = True
                            return request(payload)

                        second_future = pool.submit(competitor_request)
                        stage = stage_queue.get(timeout=5)
                        rules = json.loads((config_dir / "rules.json").read_text(encoding="utf-8"))
                        rules["version"] = "task-intent-rules-changed-during-race"
                        (config_dir / "rules.json").write_text(
                            json.dumps(rules, ensure_ascii=False), encoding="utf-8"
                        )
                        release_competitor.set()
                        if stage == "insert":
                            # The competitor is now issuing its insert while the winner
                            # still owns the unique-key row in a separate PG connection.
                            import time
                            time.sleep(0.1)
                        release_plan.set()
                        first_result = first_future.result(timeout=8)
                        second_result = second_future.result(timeout=8)

                self.assertEqual(first_result[0], 201)
                self.assertEqual(second_result[0], 201)
                self.assertEqual(first_result[1], second_result[1])
                self.assertEqual(plan.call_count, 1)
                workflow = WorkflowTask.objects.get(
                    creation_idempotency_key=payload["idempotency_key"]
                )
                self.assertEqual(WorkflowTask.objects.count(), 1)
                self.assertEqual(WorkflowStep.objects.filter(task=workflow, step_key="center_plan").count(), 1)
                self.assertEqual(SubTask.objects.filter(task=workflow).count(), 2)
