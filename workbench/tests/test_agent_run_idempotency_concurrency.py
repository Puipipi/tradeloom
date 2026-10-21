from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from threading import Barrier, Event, local
from unittest.mock import patch

from django.db import close_old_connections
from django.db.models.query import QuerySet
from django.test import TransactionTestCase
from django.utils import timezone

from workbench.agents.contracts import AgentResult
from workbench.models import AgentRun, Task
from workbench.services import AgentRunInProgressError, WorkbenchService


class AgentRunIdempotencyConcurrencyTests(TransactionTestCase):
    reset_sequences = True

    def test_postgres_primary_key_claim_allows_only_one_dispatch(self):
        now = timezone.now()
        task = Task.objects.create(
            title="幂等并发",
            mode="demo",
            status="awaiting_confirmation",
            created_at=now,
            updated_at=now,
        )
        dispatch_started = Event()
        release_dispatch = Event()
        dispatch_calls = []

        class Registry:
            def dispatch(self, _request):
                dispatch_calls.append(1)
                dispatch_started.set()
                if not release_dispatch.wait(timeout=10):
                    raise TimeoutError("并发测试未释放dispatch")
                return AgentResult(status="needs_confirmation", output={"count": 0})

        registry = Registry()

        def invoke():
            close_old_connections()
            try:
                try:
                    return WorkbenchService().dispatch_agent(
                        task.id,
                        "product_profile",
                        "concurrent-key",
                    )
                except AgentRunInProgressError as exc:
                    return {"run_id": exc.run_id, "status": "running"}
            finally:
                close_old_connections()

        with patch("workbench.services.build_default_registry", return_value=registry):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(invoke)
                self.assertTrue(dispatch_started.wait(timeout=5))
                second = executor.submit(invoke)
                second_result = second.result(timeout=5)
                release_dispatch.set()
                first_result = first.result(timeout=5)

        self.assertEqual(len(dispatch_calls), 1)
        self.assertEqual(AgentRun.objects.filter(task=task).count(), 1)
        run = AgentRun.objects.get(task=task)
        self.assertEqual(first_result["run_id"], run.run_id)
        self.assertEqual(second_result["run_id"], run.run_id)

    def test_simultaneous_empty_claims_race_on_postgres_unique_primary_key(self):
        now = timezone.now()
        task = Task.objects.create(
            title="幂等插入竞争",
            mode="demo",
            status="awaiting_confirmation",
            created_at=now,
            updated_at=now,
        )
        initial_probe_barrier = Barrier(2)
        dispatch_started = Event()
        release_dispatch = Event()
        dispatch_calls = []
        thread_state = local()
        original_first = QuerySet.first

        class Registry:
            def dispatch(self, _request):
                dispatch_calls.append(1)
                dispatch_started.set()
                if not release_dispatch.wait(timeout=10):
                    raise TimeoutError("并发测试未释放dispatch")
                return AgentResult(status="needs_confirmation", output={"count": 0})

        registry = Registry()

        def synchronized_first(queryset):
            result = original_first(queryset)
            if (
                queryset.model is AgentRun
                and not getattr(thread_state, "initial_probe_seen", False)
            ):
                thread_state.initial_probe_seen = True
                initial_probe_barrier.wait(timeout=5)
            return result

        def invoke():
            close_old_connections()
            try:
                try:
                    return WorkbenchService().dispatch_agent(
                        task.id,
                        "product_profile",
                        "insert-race-key",
                    )
                except AgentRunInProgressError as exc:
                    return {"run_id": exc.run_id, "status": "running"}
            finally:
                close_old_connections()

        with (
            patch("workbench.services.build_default_registry", return_value=registry),
            patch.object(QuerySet, "first", synchronized_first),
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(invoke) for _ in range(2)]
                self.assertTrue(dispatch_started.wait(timeout=5))
                completed, _pending = wait(
                    futures,
                    timeout=5,
                    return_when=FIRST_COMPLETED,
                )
                self.assertEqual(len(completed), 1)
                first_done = next(iter(completed)).result()
                self.assertEqual(first_done["status"], "running")
                release_dispatch.set()
                results = [future.result(timeout=5) for future in futures]

        self.assertEqual(len(dispatch_calls), 1)
        self.assertEqual(AgentRun.objects.filter(task=task).count(), 1)
        run = AgentRun.objects.get(task=task)
        self.assertEqual({result["run_id"] for result in results}, {run.run_id})
