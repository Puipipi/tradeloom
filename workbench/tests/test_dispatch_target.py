from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, SimpleTestCase

from workbench import api
from workbench.workflows.dispatch_target import resolve_dispatch_target


class _EmptyReviewQuery:
    def filter(self, **_kwargs):
        return self

    def exists(self):
        return False


class _StepQuery:
    def __init__(self, workflow, step_key):
        self.workflow = workflow
        self.step_key = step_key

    def order_by(self, *_fields):
        return self

    def first(self):
        if self.step_key == "apply_review_cycle":
            return SimpleNamespace(
                id="apply-7",
                output_refs={"resume_authority": {"sub-1": {
                    "expected_prior_step_id": "step-2",
                    "next_attempt": 2,
                }}},
            )
        return SimpleNamespace(id="step-2")


class DispatchTargetTests(SimpleTestCase):
    def workflow(self):
        dependency = SimpleNamespace(task_id="wf-1", status="completed")
        subtask = SimpleNamespace(
            id="sub-1", status="queued", depends_on=SimpleNamespace(all=lambda: [dependency])
        )
        return SimpleNamespace(
            id="wf-1", status="running", subtasks=SimpleNamespace(all=lambda: [subtask]),
            human_reviews=_EmptyReviewQuery(),
        )

    @patch("workbench.workflows.dispatch_target.WorkflowStep.objects.filter")
    def test_resume_key_is_selected_from_server_authority_without_returning_authority(self, filter_steps):
        filter_steps.side_effect = lambda **kwargs: _StepQuery(self.workflow(), kwargs["step_key"])
        target = resolve_dispatch_target(self.workflow())
        self.assertEqual(target, {
            "subtask_id": "sub-1",
            "idempotency_key": "workflow:wf-1:subtask:sub-1:resume:apply-7:prior:step-2:attempt:2",
            "blocked_reason": "",
        })
        self.assertNotIn("resume_authority", str(target))

    @patch("workbench.workflows.dispatch_target.WorkflowStep.objects.filter")
    def test_human_review_blocks_dispatch_and_returns_no_key(self, filter_steps):
        workflow = self.workflow()
        workflow.human_reviews.filter = lambda **_kwargs: SimpleNamespace(exists=lambda: True)
        target = resolve_dispatch_target(workflow)
        filter_steps.assert_not_called()
        self.assertEqual(target["subtask_id"], "")
        self.assertEqual(target["idempotency_key"], "")
        self.assertIn("人审", target["blocked_reason"])

    @patch("workbench.api.resolve_dispatch_target", return_value={
        "subtask_id": "sub-1",
        "idempotency_key": "workflow:wf-1:subtask:sub-1:resume:apply-7:prior:step-2:attempt:2",
        "blocked_reason": "",
    })
    @patch("workbench.api.serialize_prepared_workflow", return_value={"id": "wf-1"})
    @patch("workbench.api.collaboration_event_metadata", return_value=[])
    @patch("workbench.api.project_collaboration_envelope", return_value={"schema_version": 1})
    @patch("workbench.api.get_prepared_workflow")
    def test_workflow_api_exposes_only_the_dispatch_target_dto(self, get_workflow, _project_collaboration, _events, _serialize, _resolve):
        workflow = SimpleNamespace(id="wf-1")
        get_workflow.return_value = workflow
        response = api.get_workflow_task(RequestFactory().get("/api/workflow-tasks/wf-1"), "wf-1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["dispatch_target"], {
            "subtask_id": "sub-1",
            "idempotency_key": "workflow:wf-1:subtask:sub-1:resume:apply-7:prior:step-2:attempt:2",
            "blocked_reason": "",
        })
        self.assertEqual(json.loads(response.content)["collaboration"], {"schema_version": 1})
        _events.assert_called_once_with("wf-1")
        self.assertNotIn("resume_authority", response.content.decode())
