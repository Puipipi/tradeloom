from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from workbench.agents.context import WorkflowContext, _validate_product_data
from workbench.agents.mock_runtime import MockAgentRuntime
from workbench.agents.workflow_contracts import WorkflowRoleError
from workbench.models import (
    EventLog,
    HumanReview,
    Product,
    ProductRevision,
    SubTask,
    Task,
    TaskFile,
    WorkflowStep,
    WorkflowTask,
)
from workbench.workflows.orchestrator import DependencyNotReady, WorkflowOrchestrator
from workbench.workflows.reviews import (
    ReviewSubmissionConflict,
    _supported_sku_answer,
    _validate_sku_assignment_preflight,
)
from workbench.workflows.fact_application import (
    FactApplicationConflict,
    _prospective_sku_assignments,
    _typed_literal,
)
from workbench.workflows.validation import (
    _validated_duplicate_sku_group,
    build_review_candidates,
    persist_review_candidates,
)


class DuplicateSkuValidationTests(SimpleTestCase):
    def make_context(self, rows):
        products = []
        revisions = {}
        for index, (product_id, sku) in enumerate(rows):
            products.append(
                SimpleNamespace(
                    id=product_id,
                    sku=sku,
                    position=index,
                    name=f"Item {index}",
                    category="accessory",
                    material="cotton",
                    size="25mm",
                    color="blue",
                    image_filename=f"{product_id}.png",
                    image_stored_name=f"{product_id}.png",
                    missing_fields=[],
                )
            )
            revisions[product_id] = SimpleNamespace(
                id=f"revision-{product_id}",
                product_id=product_id,
                version=1,
                status="confirmed",
                snapshot={
                    "sku": sku,
                    "name": f"Item {index}",
                    "category": "accessory",
                    "material": "cotton",
                    "size": "25mm",
                    "color": "blue",
                    "image_filename": f"{product_id}.png",
                    "english_name": "Item",
                },
            )
        return SimpleNamespace(
            products=tuple(products),
            current_revisions=revisions,
            files=(),
            product_ids=[item.id for item in products],
        )

    def test_duplicate_detection_freezes_trimmed_case_sensitive_group_even_for_subset(self):
        context = self.make_context(
            [("p1", " SKU-1 "), ("p2", "SKU-1"), ("p3", "sku-1")]
        )

        result = _validate_product_data(context, product_ids=["p1"])

        self.assertIn("duplicate_sku", result["p1"]["uncertainties"])
        self.assertEqual(
            result["p1"]["source_refs"]["duplicate_sku_group"],
            {
                "sku": "SKU-1",
                "members": [
                    {"product_id": "p1", "revision_id": "revision-p1"},
                    {"product_id": "p2", "revision_id": "revision-p2"},
                ],
            },
        )
        self.assertNotIn("duplicate_sku", result.get("p3", {}).get("uncertainties", []))

    def test_single_and_empty_skus_do_not_create_duplicate_groups(self):
        context = self.make_context(
            [("p1", "SKU-1"), ("p2", "sku-1"), ("p3", "   ")]
        )

        result = _validate_product_data(context)

        self.assertNotIn("duplicate_sku", result["p1"]["uncertainties"])
        self.assertNotIn("duplicate_sku", result["p2"]["uncertainties"])
        self.assertNotIn("duplicate_sku", result["p3"]["uncertainties"])

    def test_duplicate_group_requires_exact_current_members_and_revisions(self):
        context = self.make_context([("p1", "SKU-1"), ("p2", "SKU-1")])
        group = {
            "sku": "SKU-1",
            "members": [
                {"product_id": "p1", "revision_id": "revision-p1"},
                {"product_id": "p2", "revision_id": "revision-p2"},
            ],
        }

        self.assertEqual(
            _validated_duplicate_sku_group(
                context,
                product_id="p1",
                item_source_refs={"revision_id": "revision-p1", "duplicate_sku_group": group},
            ),
            group,
        )
        tampered = {
            "sku": "SKU-1",
            "members": [{"product_id": "p1", "revision_id": "revision-p1"}],
        }
        with self.assertRaises(ValueError):
            _validated_duplicate_sku_group(
                context,
                product_id="p1",
                item_source_refs={"revision_id": "revision-p1", "duplicate_sku_group": tampered},
            )

    def test_typed_duplicate_answer_is_signal_bound_and_trims_sku(self):
        review = SimpleNamespace(
            source_conflict={
                "source_refs": {
                    "signal": {"uncertainty": "duplicate_sku"},
                }
            }
        )

        self.assertEqual(
            _supported_sku_answer(
                review,
                {"type": "resolve_duplicate_sku", "value": " SKU-2 "},
            ),
            "SKU-2",
        )
        self.assertIsNone(
            _supported_sku_answer(
                review,
                {"type": "resolve_duplicate_sku", "value": "SKU-2", "extra": "x"},
            )
        )
        review.source_conflict["source_refs"]["signal"] = {"uncertainty": "no_image_candidate"}
        self.assertIsNone(
            _supported_sku_answer(
                review,
                {"type": "resolve_duplicate_sku", "value": "SKU-2"},
            )
        )

    def test_fact_application_accepts_only_duplicate_signal_typed_sku(self):
        group = {
            "sku": "SKU-1",
            "members": [
                {"product_id": "p1", "revision_id": "r1"},
                {"product_id": "p2", "revision_id": "r2"},
            ],
        }
        refs = {
            "product_id": "p1",
            "revision_id": "r1",
            "duplicate_sku_group": group,
            "signal": {"uncertainty": "duplicate_sku"},
        }
        review = SimpleNamespace(
            answer={"response": {"type": "resolve_duplicate_sku", "value": " SKU-2 "}}
        )

        self.assertEqual(_typed_literal(review, refs), ("p1", "sku", "SKU-2"))
        with self.assertRaises(FactApplicationConflict):
            _typed_literal(
                SimpleNamespace(
                    answer={"response": {"type": "resolve_duplicate_sku", "value": "SKU-2"}}
                ),
                {**refs, "signal": {"uncertainty": "no_image_candidate"}},
            )

    def test_apply_checks_trimmed_case_sensitive_full_batch_sku_set(self):
        products = [
            SimpleNamespace(id="p1", sku="old-1"),
            SimpleNamespace(id="p2", sku="old-2"),
        ]
        revisions = {
            "p1": SimpleNamespace(snapshot={"sku": "SKU-1"}),
            "p2": SimpleNamespace(snapshot={"sku": "SKU-2"}),
        }

        self.assertEqual(
            _prospective_sku_assignments(products, revisions, {"p1": {"sku": " NEW "}}),
            {"p1": "NEW", "p2": "SKU-2"},
        )
        self.assertEqual(
            _prospective_sku_assignments(
                products,
                revisions,
                {"p1": {"sku": "SKU-2"}, "p2": {"sku": "SKU-1"}},
            ),
            {"p1": "SKU-2", "p2": "SKU-1"},
        )
        self.assertEqual(
            _prospective_sku_assignments(
                products,
                revisions,
                {"p1": {"sku": " sku-2 "}, "p2": {"sku": "SKU-1"}},
            ),
            {"p1": "sku-2", "p2": "SKU-1"},
        )
        with self.assertRaises(FactApplicationConflict):
            _prospective_sku_assignments(products, revisions, {"p1": {"sku": "SKU-2"}})
    def test_partial_preflight_allows_first_member_but_rejects_last_duplicate(self):
        origin_id = "origin-1"
        def review(product_id, status, response=None):
            return SimpleNamespace(
                id=f"review-{product_id}",
                status=status,
                answer={"response": response} if response is not None else {},
                source_conflict={
                    "origin_step_id": origin_id,
                    "source_refs": {
                        "product_id": product_id,
                        "signal": {"uncertainty": "duplicate_sku"},
                    },
                },
            )

        first = review("p1", "pending")
        second = review("p2", "pending")
        products = [
            SimpleNamespace(id="p1", sku="SKU-1"),
            SimpleNamespace(id="p2", sku="SKU-1"),
            SimpleNamespace(id="p3", sku="SKU-3"),
        ]
        revisions = [
            SimpleNamespace(product_id="p1", version=1, snapshot={"sku": "SKU-1"}),
            SimpleNamespace(product_id="p2", version=1, snapshot={"sku": "SKU-1"}),
            SimpleNamespace(product_id="p3", version=1, snapshot={"sku": "SKU-3"}),
        ]

        with patch.object(ProductRevision.objects, "select_for_update") as lock_revisions:
            lock_revisions.return_value.filter.return_value.order_by.return_value = revisions
            _validate_sku_assignment_preflight(
                workflow=None,
                products=products,
                reviews=[first, second],
                review=first,
                response={"type": "resolve_duplicate_sku", "value": "SKU-1"},
            )
            first.status = "submitted"
            first.answer = {
                "response": {"type": "resolve_duplicate_sku", "value": "SKU-1"}
            }
            with self.assertRaises(ReviewSubmissionConflict):
                _validate_sku_assignment_preflight(
                    workflow=None,
                    products=products,
                    reviews=[first, second],
                    review=second,
                    response={"type": "resolve_duplicate_sku", "value": "SKU-1"},
                )

    def test_partial_preflight_includes_nonreviewed_products(self):
        current = SimpleNamespace(
            status="pending",
            answer={},
            source_conflict={
                "origin_step_id": "origin-1",
                "source_refs": {
                    "product_id": "p1",
                    "signal": {"uncertainty": "duplicate_sku"},
                },
            },
        )
        products = [
            SimpleNamespace(id="p1", sku="SKU-1"),
            SimpleNamespace(id="p2", sku="SKU-1"),
            SimpleNamespace(id="p3", sku="SKU-2"),
        ]
        revisions = [
            SimpleNamespace(product_id="p1", version=1, snapshot={"sku": "SKU-1"}),
            SimpleNamespace(product_id="p2", version=1, snapshot={"sku": "SKU-1"}),
            SimpleNamespace(product_id="p3", version=1, snapshot={"sku": "SKU-2"}),
        ]

        with patch.object(ProductRevision.objects, "select_for_update") as lock_revisions:
            lock_revisions.return_value.filter.return_value.order_by.return_value = revisions
            with self.assertRaises(ReviewSubmissionConflict):
                _validate_sku_assignment_preflight(
                    workflow=None,
                    products=products,
                    reviews=[current],
                    review=current,
                    response={"type": "resolve_duplicate_sku", "value": "SKU-2"},
                )


class ReviewCandidatePersistenceTests(TestCase):
    def setUp(self):
        self.batch, self.product, self.revision = self.make_batch_product(
            material="",
            english_name="",
            image_file=False,
        )
        self.workflow, self.engine, self.product_subtask, self.delivery_subtask = (
            self.make_workflow(self.batch)
        )

    def make_batch_product(
        self, *, material: str, english_name: str, image_file: bool
    ):
        now = timezone.now()
        batch = Task.objects.create(
            title="Task12a review fixture",
            mode="demo",
            status="confirmed",
            created_at=now,
            updated_at=now,
        )
        product = Product.objects.create(
            task=batch,
            position=0,
            sku="TL-12A",
            name="演示商品",
            category="配件",
            material=material,
            size="25mm",
            color="蓝色",
            image_filename="TL-12A.png",
            image_stored_name="TL-12A.png",
            missing_fields=[],
            created_at=now,
            updated_at=now,
        )
        revision = ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot={
                "sku": product.sku,
                "name": product.name,
                "category": product.category,
                "material": material,
                "size": product.size,
                "color": product.color,
                "image_filename": product.image_filename,
                "english_name": english_name,
            },
            status="confirmed",
        )
        if image_file:
            TaskFile.objects.create(
                task=batch,
                kind="image",
                original_name="TL-12A.png",
                stored_name="TL-12A.png",
                created_at=now,
            )
        return batch, product, revision

    def make_workflow(self, batch):
        workflow = WorkflowTask.objects.create(
            batch=batch,
            user_goal="检查当前演示资料",
            task_type="prepare_product_data",
            status="queued",
        )
        engine = WorkflowOrchestrator(MockAgentRuntime())
        engine.plan_task(workflow.id)
        product_subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
        delivery_subtask = SubTask.objects.get(task=workflow, agent_role="delivery_quality")
        return workflow, engine, product_subtask, delivery_subtask

    def add_revision_product(self, *, sku, position):
        product = Product.objects.create(
            task=self.batch,
            position=position,
            sku=sku,
            name=f"商品 {position}",
            category="配件",
            material="棉",
            size="25mm",
            color="蓝色",
            image_filename=f"{sku}-{position}.png",
            image_stored_name=f"{sku}-{position}.png",
            missing_fields=[],
            created_at=timezone.now(),
            updated_at=timezone.now(),
        )
        revision = ProductRevision.objects.create(
            product=product,
            version=1,
            snapshot={
                "sku": sku,
                "name": product.name,
                "category": product.category,
                "material": product.material,
                "size": product.size,
                "color": product.color,
                "image_filename": product.image_filename,
                "english_name": "Item",
            },
            status="confirmed",
        )
        return product, revision

    def test_duplicate_sku_detection_uses_all_products_and_trimmed_case_sensitive_values(self):
        duplicate, duplicate_revision = self.add_revision_product(
            sku=" TL-12A ", position=1
        )
        lowercase, _ = self.add_revision_product(sku="tl-12a", position=2)

        context = WorkflowContext.from_workflow(self.workflow)
        result = _validate_product_data(context, product_ids=[self.product.id])

        self.assertIn(
            "duplicate_sku",
            result[self.product.id]["uncertainties"],
        )
        group = result[self.product.id]["source_refs"]["duplicate_sku_group"]
        self.assertEqual(group["sku"], "TL-12A")
        self.assertEqual(
            group["members"],
            [
                {"product_id": self.product.id, "revision_id": self.revision.id},
                {"product_id": duplicate.id, "revision_id": duplicate_revision.id},
            ],
        )
        self.assertNotIn(
            "duplicate_sku",
            _validate_product_data(context, product_ids=[lowercase.id])[lowercase.id][
                "uncertainties"
            ],
        )

    def test_single_product_subset_does_not_hide_same_batch_duplicate(self):
        duplicate, _revision = self.add_revision_product(sku="TL-12A", position=1)

        result = _validate_product_data(
            WorkflowContext.from_workflow(self.workflow),
            product_ids=[self.product.id],
        )

        self.assertIn("duplicate_sku", result[self.product.id]["uncertainties"])
        self.assertEqual(
            result[self.product.id]["source_refs"]["duplicate_sku_group"]["members"][1][
                "product_id"
            ],
            duplicate.id,
        )

    def test_real_product_role_signals_create_pending_reviews_with_current_refs(self):
        subtask = self.engine.dispatch_subtask(
            self.product_subtask.id,
            "task12a-product-needs-review",
        )

        self.assertEqual(subtask.status, "waiting_human")
        self.workflow.refresh_from_db()
        self.assertEqual(self.workflow.status, "waiting_human")
        result = subtask.output_refs["result"]
        product_result = result["products"][0]
        self.assertEqual(result["status"], "needs_human")
        self.assertIn("material", product_result["missing_fields"])
        self.assertIn("no_image_candidate", product_result["uncertainties"])
        reviews = list(HumanReview.objects.filter(task=self.workflow).order_by("review_key"))
        self.assertGreaterEqual(len(reviews), 2)
        self.assertTrue(all(review.status == "pending" for review in reviews))
        self.assertTrue(all(review.options == [] for review in reviews))
        self.assertTrue(all(review.answer == {} and review.reviewer == "" for review in reviews))
        for review in reviews:
            provenance = review.source_conflict
            self.assertEqual(provenance["subtask_id"], subtask.id)
            self.assertEqual(
                provenance["result_ref"],
                f"workflow_step:{provenance['origin_step_id']}:output_refs.result_snapshot",
            )
            refs = provenance["source_refs"]
            self.assertEqual(refs["workflow_task_id"], self.workflow.id)
            self.assertEqual(refs["batch_id"], self.batch.id)
            self.assertEqual(refs["product_id"], self.product.id)
            self.assertEqual(refs["revision_id"], self.revision.id)
            self.assertIn("请核对或补充", review.question)
        self.assertEqual(
            EventLog.objects.filter(task=self.workflow, event_type="human_review_created").count(),
            len(reviews),
        )
        with self.assertRaises(DependencyNotReady):
            self.engine.dispatch_subtask(self.delivery_subtask.id, "blocked-delivery")
        with self.assertRaises(DependencyNotReady):
            self.engine.resume_task(self.workflow.id)

    def test_delivery_role_checks_create_review_items_from_real_role_output(self):
        # The delivery adapter is exercised with the actual delivery role output;
        # its dependency is marked complete so this test isolates that role seam.
        self.product_subtask.status = "completed"
        self.product_subtask.save(update_fields=["status"])

        delivery = self.engine.dispatch_subtask(
            self.delivery_subtask.id,
            "task12a-delivery-needs-review",
        )

        self.assertEqual(delivery.status, "waiting_human")
        result = delivery.output_refs["result"]
        self.assertEqual(result["status"], "needs_human")
        self.assertTrue(
            any(check.get("status") == "needs_human" for check in result["checks"])
        )
        reviews = list(HumanReview.objects.filter(task=self.workflow))
        self.assertGreaterEqual(len(reviews), 1)
        self.assertTrue(
            all(review.source_conflict["subtask_id"] == delivery.id for review in reviews)
        )

    def test_same_result_replay_reuses_reviews_and_does_not_repeat_events(self):
        subtask = self.engine.dispatch_subtask(
            self.product_subtask.id,
            "task12a-product-idempotent",
        )
        before = EventLog.objects.filter(task=self.workflow).count()
        review_ids = set(HumanReview.objects.filter(task=self.workflow).values_list("id", flat=True))

        replay = self.engine.dispatch_subtask(
            subtask.id,
            "task12a-product-idempotent",
        )
        origin_step = WorkflowStep.objects.get(
            task=self.workflow,
            step_key=f"subtask:{subtask.id}",
            attempt=1,
        )
        again = persist_review_candidates(
            self.workflow.id,
            subtask.id,
            subtask.output_refs["result"],
            origin_step=origin_step,
        )

        self.assertEqual(replay.status, "waiting_human")
        self.assertEqual(set(review_ids), {review.id for review in again})
        self.assertEqual(HumanReview.objects.filter(task=self.workflow).count(), len(review_ids))
        self.assertEqual(EventLog.objects.filter(task=self.workflow).count(), before)

    def test_needs_human_without_parseable_signal_creates_one_generic_candidate(self):
        class GenericNeedsHumanRuntime:
            def run_subtask(inner_self, _subtask_id):
                return {
                    "schema_version": "workflow-role-result.v1",
                    "role": "product_profile",
                    "task_id": self.workflow.id,
                    "batch_id": self.batch.id,
                    "status": "needs_human",
                    "products": [],
                    "source_refs": {
                        "workflow_task_id": self.workflow.id,
                        "batch_id": self.batch.id,
                        "product_ids": [self.product.id],
                    },
                    "facts_changed": False,
                }

        engine = WorkflowOrchestrator(GenericNeedsHumanRuntime())
        engine.plan_task(self.workflow.id)
        subtask = SubTask.objects.get(task=self.workflow, agent_role="product_profile")
        engine.dispatch_subtask(subtask.id, "task12a-generic-needs-human")

        reviews = list(HumanReview.objects.filter(task=self.workflow))
        self.assertEqual(len(reviews), 1)
        self.assertEqual(reviews[0].item_ref, f"subtask:{subtask.id}")
        self.assertEqual(reviews[0].source_conflict["kind"], "role_needs_human")
        self.assertEqual(
            reviews[0].source_conflict["result_ref"],
            f"workflow_step:{reviews[0].source_conflict['origin_step_id']}:output_refs.result_snapshot",
        )

    def test_foreign_batch_stale_revision_and_foreign_file_refs_fail_without_reviews(self):
        foreign_batch, foreign_product, _ = self.make_batch_product(
            material="聚酯",
            english_name="Item",
            image_file=True,
        )
        foreign_file = TaskFile.objects.get(task=foreign_batch, kind="image")

        invalid_refs = (
            "foreign_product",
            "stale_revision",
            "same_batch_wrong_revision",
            "foreign_file",
            "fallback_foreign_file",
            "fallback_non_list_task_files",
            "non_list_task_files",
        )
        for index, invalid_ref in enumerate(invalid_refs):
            with self.subTest(invalid_ref=invalid_ref):
                batch, product, revision = self.make_batch_product(
                    material="",
                    english_name="",
                    image_file=invalid_ref == "non_list_task_files",
                )
                workflow, _engine, _product_subtask, _delivery = self.make_workflow(batch)
                other_revision = None
                if invalid_ref == "same_batch_wrong_revision":
                    now = timezone.now()
                    other_product = Product.objects.create(
                        task=batch,
                        position=1,
                        sku="TL-OTHER",
                        name="同批另一商品",
                        category="配件",
                        material="聚酯",
                        size="25mm",
                        color="蓝色",
                        image_filename="TL-OTHER.png",
                        created_at=now,
                        updated_at=now,
                    )
                    other_revision = ProductRevision.objects.create(
                        product=other_product,
                        version=1,
                        snapshot={"sku": other_product.sku},
                        status="confirmed",
                    )
                same_batch_file = TaskFile.objects.filter(task=batch).first()

                class InvalidRefsRuntime:
                    def run_subtask(inner_self, _subtask_id):
                        if invalid_ref in ("fallback_foreign_file", "fallback_non_list_task_files"):
                            source_refs = {
                                "workflow_task_id": workflow.id,
                                "batch_id": batch.id,
                            }
                            if invalid_ref == "fallback_foreign_file":
                                source_refs["task_file_ids"] = [foreign_file.id]
                            else:
                                source_refs["task_file_ids"] = {foreign_file.id: "not a list"}
                            return {
                                "schema_version": "workflow-role-result.v1",
                                "role": "product_profile",
                                "task_id": workflow.id,
                                "batch_id": batch.id,
                                "status": "needs_human",
                                "products": [],
                                "source_refs": source_refs,
                                "facts_changed": False,
                            }
                        result = MockAgentRuntime().run_subtask(_subtask_id)
                        item = result["products"][0]
                        refs = item["source_refs"]
                        if invalid_ref == "foreign_product":
                            refs["product_id"] = foreign_product.id
                        elif invalid_ref == "stale_revision":
                            ProductRevision.objects.create(
                                product=product,
                                version=revision.version + 1,
                                snapshot=revision.snapshot,
                                status="confirmed",
                            )
                        elif invalid_ref == "same_batch_wrong_revision":
                            refs["revision_id"] = other_revision.id
                        else:
                            if invalid_ref == "foreign_file":
                                refs["task_file_ids"] = [foreign_file.id]
                            elif invalid_ref == "non_list_task_files":
                                refs["task_file_ids"] = {same_batch_file.id: "not a list"}
                        return result

                engine = WorkflowOrchestrator(InvalidRefsRuntime())
                product_subtask = SubTask.objects.get(task=workflow, agent_role="product_profile")
                with self.assertRaises((ValueError, WorkflowRoleError)):
                    engine.dispatch_subtask(product_subtask.id, f"invalid-review-ref-{index}")
                workflow.refresh_from_db()
                product_subtask.refresh_from_db()
                self.assertEqual(workflow.status, "failed")
                self.assertEqual(product_subtask.status, "failed")
                self.assertFalse(HumanReview.objects.filter(task=workflow).exists())
                self.assertFalse(
                    EventLog.objects.filter(task=workflow, event_type="human_review_created").exists()
                )

    def test_revision_must_belong_to_the_candidate_product(self):
        result = MockAgentRuntime().run_subtask(self.product_subtask.id)
        now = timezone.now()
        other_product = Product.objects.create(
            task=self.batch,
            position=1,
            sku="TL-OTHER",
            name="同批另一商品",
            category="配件",
            material="聚酯",
            size="25mm",
            color="蓝色",
            image_filename="TL-OTHER.png",
            created_at=now,
            updated_at=now,
        )
        other_revision = ProductRevision.objects.create(
            product=other_product,
            version=1,
            snapshot={"sku": other_product.sku},
            status="confirmed",
        )
        result["products"][0]["source_refs"]["revision_id"] = other_revision.id

        with self.assertRaisesRegex(ValueError, "revision_id 不属于对应产品"):
            build_review_candidates(self.workflow, self.product_subtask, result)

    def test_second_candidate_write_failure_rolls_back_all_reviews_then_records_failure(self):
        original = None
        calls = 0

        def fail_on_second_event(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("review event write failed")
            return original(**kwargs)

        with patch("workbench.workflows.validation.record_workflow_event") as event_writer:
            original = event_writer.side_effect
            from workbench.workflows.events import record_workflow_event

            original = record_workflow_event
            event_writer.side_effect = fail_on_second_event
            with self.assertRaisesRegex(RuntimeError, "review event write failed"):
                self.engine.dispatch_subtask(
                    self.product_subtask.id,
                    "task12a-second-review-fails",
                )

        self.workflow.refresh_from_db()
        self.product_subtask.refresh_from_db()
        step = WorkflowStep.objects.get(
            task=self.workflow,
            idempotency_key="task12a-second-review-fails",
        )
        self.assertEqual(self.workflow.status, "failed")
        self.assertEqual(self.product_subtask.status, "failed")
        self.assertEqual(step.status, "failed")
        self.assertFalse(HumanReview.objects.filter(task=self.workflow).exists())
        self.assertFalse(
            EventLog.objects.filter(task=self.workflow, event_type="human_review_created").exists()
        )
        self.assertTrue(EventLog.objects.filter(task=self.workflow, event_type="subtask_failed").exists())

