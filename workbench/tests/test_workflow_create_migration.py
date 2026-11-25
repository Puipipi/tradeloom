from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone

from workbench.testing import fresh_migration_database


class WorkflowCreateIdempotencyMigrationTests(TransactionTestCase):
    """0002→0003 迁移验证。

    0017 起的 workbench 迁移不可逆，共享测试库无法回滚穿越；
    改为一次性库从零正向迁移到 0002，全程不触碰 0017 及之后的迁移。
    """
    migrate_from = ("workbench", "0002_workflow_domain")
    migrate_to = ("workbench", "0003_workflow_create_idempotency")

    def test_legacy_workflow_and_relations_survive_expand_migration(self):
        with fresh_migration_database() as conn:
            executor = MigrationExecutor(conn)
            executor.migrate([self.migrate_from])
            old_apps = executor.loader.project_state([self.migrate_from]).apps
            Task = old_apps.get_model("workbench", "Task")
            WorkflowTask = old_apps.get_model("workbench", "WorkflowTask")
            SubTask = old_apps.get_model("workbench", "SubTask")
            WorkflowStep = old_apps.get_model("workbench", "WorkflowStep")
            now = timezone.now()

            batch = Task.objects.create(
                id="b" * 32,
                title="Legacy batch",
                mode="demo",
                status="confirmed",
                created_at=now,
                updated_at=now,
            )
            workflow = WorkflowTask.objects.create(
                id="w" * 32,
                batch=batch,
                user_goal="Legacy goal",
                task_type="prepare_product_data",
                status="queued",
            )
            subtask = SubTask.objects.create(
                task=workflow,
                agent_role="product_profile",
                status="queued",
            )
            WorkflowStep.objects.create(
                task=workflow,
                step_key="legacy-step",
                status="completed",
                attempt=1,
                output_refs={"canonical_result_ref": f"subtask:{subtask.id}"},
            )

            executor = MigrationExecutor(conn)
            executor.migrate([self.migrate_to])
            new_apps = executor.loader.project_state([self.migrate_to]).apps
            NewWorkflowTask = new_apps.get_model("workbench", "WorkflowTask")
            migrated = NewWorkflowTask.objects.get(pk=workflow.pk)
            self.assertEqual(migrated.batch_id, batch.pk)
            self.assertEqual(migrated.subtasks.count(), 1)
            self.assertEqual(migrated.steps.count(), 1)
            self.assertIsNone(migrated.creation_idempotency_key)
            self.assertIsNone(migrated.creation_request_fingerprint)
            self.assertIsNone(migrated.creation_receipt)
