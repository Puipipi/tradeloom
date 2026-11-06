from __future__ import annotations

import hashlib
import json
import uuid
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import Client, TestCase

from workbench.models import (
    Customer,
    CustomerAction,
    CustomerAlias,
    CustomerEvent,
    CustomerMetricSnapshot,
    CustomerPrediction,
    IntakeCandidate,
    IntakeMappingRevision,
    IntakeSourceVersion,
    SourceCellSnapshot,
    WorkbookSheetSnapshot,
    WorkbookSnapshot,
)


class CustomerFixtureMixin:
    def setUp(self):
        self.client = Client()

    def create_candidate(self, party_text="Customer-A", reference=None):
        suffix = uuid.uuid4().hex
        reference = reference or f"SO-{suffix[:8]}"
        source_sha256 = hashlib.sha256(f"source:{suffix}".encode()).hexdigest()
        source = IntakeSourceVersion.objects.create(
            sha256=source_sha256,
            storage_key=f"synthetic/{suffix}.xlsx",
            original_name=f"{suffix}.xlsx",
            byte_size=128,
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        snapshot = WorkbookSnapshot.objects.create(
            source=source,
            parser_version="synthetic-v1",
            status="ready",
            sheet_count=1,
            cell_count=2,
        )
        sheet = WorkbookSheetSnapshot.objects.create(
            snapshot=snapshot,
            sheet_index=1,
            title="Orders",
            source_part="xl/worksheets/sheet1.xml",
        )
        SourceCellSnapshot.objects.create(
            sheet=sheet,
            coordinate="A1",
            raw_value=party_text,
            normalized_value=party_text,
        )
        SourceCellSnapshot.objects.create(
            sheet=sheet,
            coordinate="B1",
            raw_value=reference,
            normalized_value=reference,
        )
        locator = {
            "snapshot_id": snapshot.pk,
            "source_id": source.pk,
            "source_sha256": source_sha256,
            "sheet_index": 1,
        }
        mapping = IntakeMappingRevision.objects.create(
            snapshot=snapshot,
            source_sha256=source_sha256,
            candidate_type="commercial_source",
            schema_version=1,
            revision=1,
            mapping={},
            mapping_sha256=hashlib.sha256(f"mapping:{suffix}".encode()).hexdigest(),
            idempotency_key=f"mapping:{suffix}",
        )
        return IntakeCandidate.objects.create(
            mapping_revision=mapping,
            source_sha256=source_sha256,
            candidate_type="commercial_source",
            schema_version=1,
            typed_payload={
                "fields": {
                    "party_text": [{"state": "present", "type": "text", "value": party_text}],
                    "document_reference": [{"state": "present", "type": "text", "value": reference}],
                },
            },
            provenance={
                "party_text": [{**locator, "coordinate": "A1"}],
                "document_reference": [{**locator, "coordinate": "B1"}],
            },
            idempotency_key=f"candidate:{suffix}",
        )

    def post_event(self, candidate, occurred_on="2026-01-01", event_type="order"):
        return self.client.post(
            "/api/customer-events/from-candidate",
            data=json.dumps({
                "candidate_id": candidate.pk,
                "event_type": event_type,
                "occurred_on": occurred_on,
            }),
            content_type="application/json",
        )

    def confirm_alias(self, alias_id, display_name="Customer A"):
        return self.client.post(
            f"/api/customer-aliases/{alias_id}/decision",
            data=json.dumps({"decision": "confirm", "display_name": display_name}),
            content_type="application/json",
        )

    def create_customer_with_orders(self, party, occurred_dates):
        candidates = [self.create_candidate(party) for _ in occurred_dates]
        alias_id = self.post_event(candidates[0]).json()["alias"]["id"]
        customer_id = self.confirm_alias(alias_id, party).json()["alias"]["customer_id"]
        for candidate, occurred_on in zip(candidates, occurred_dates):
            response = self.post_event(candidate, occurred_on=occurred_on)
            self.assertEqual(response.status_code, 201, response.content)
        return customer_id

class CustomerKnowledgeLoopTests(CustomerFixtureMixin, TestCase):
    def test_unconfirmed_party_requires_human_decision_before_traceable_event(self):
        candidate = self.create_candidate()
        pending = self.post_event(candidate)
        self.assertEqual(pending.status_code, 202, pending.content)
        self.assertEqual(pending.json()["status"], "needs_confirmation")
        alias_id = pending.json()["alias"]["id"]
        self.assertEqual(CustomerEvent.objects.count(), 0)
        self.assertEqual(Customer.objects.count(), 0)

        confirmed = self.confirm_alias(alias_id)
        self.assertEqual(confirmed.status_code, 200, confirmed.content)
        customer_id = confirmed.json()["alias"]["customer_id"]
        recorded = self.post_event(candidate)
        self.assertEqual(recorded.status_code, 201, recorded.content)
        event = recorded.json()["event"]
        self.assertEqual(event["customer_id"], customer_id)
        self.assertEqual(event["source_candidate_id"], candidate.pk)
        self.assertEqual(event["source_refs"]["provenance"]["party_text"][0]["coordinate"], "A1")
        self.assertEqual(event["source_refs"]["event_type_source"], "operator_classification")
        self.assertEqual(event["source_refs"]["occurred_on_source"], "operator_supplement")

        replay = self.post_event(candidate)
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["event"]["id"], event["id"])
        self.assertEqual(CustomerEvent.objects.count(), 1)
        conflicting = self.post_event(candidate, occurred_on="2026-01-02")
        self.assertEqual(conflicting.status_code, 409, conflicting.content)
        self.assertEqual(conflicting.json()["error_code"], "idempotency_conflict")

        rejected = self.client.post(
            f"/api/customer-aliases/{alias_id}/decision",
            data=json.dumps({"decision": "reject"}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 409, rejected.content)
        detail = self.client.get(f"/api/customers/{customer_id}")
        self.assertEqual(detail.status_code, 200, detail.content)
        self.assertEqual(detail.json()["customer"]["events"][0]["id"], event["id"])

    def test_similar_name_is_not_automatically_merged(self):
        first = self.create_candidate("Customer-A")
        pending = self.post_event(first)
        self.confirm_alias(pending.json()["alias"]["id"])
        self.assertEqual(self.post_event(first).status_code, 201)

        similar = self.create_candidate("Customer A")
        response = self.post_event(similar, occurred_on="2026-02-01")
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json()["alias"]["decision"], "suggested")
        self.assertNotEqual(response.json()["alias"]["id"], pending.json()["alias"]["id"])
        self.assertEqual(Customer.objects.count(), 1)
        self.assertEqual(CustomerEvent.objects.count(), 1)

    def test_rejected_party_remains_outside_customer_ledger(self):
        candidate = self.create_candidate("Not-A-Customer")
        alias_id = self.post_event(candidate).json()["alias"]["id"]
        rejected = self.client.post(
            f"/api/customer-aliases/{alias_id}/decision",
            data=json.dumps({"decision": "reject"}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 200, rejected.content)
        blocked = self.post_event(candidate)
        self.assertEqual(blocked.status_code, 409, blocked.content)
        self.assertEqual(blocked.json()["error_code"], "party_rejected")
        self.assertEqual(Customer.objects.count(), 0)
        self.assertEqual(CustomerEvent.objects.count(), 0)

    def test_three_orders_produce_traceable_idempotent_followup_loop(self):
        first = self.create_candidate()
        alias_id = self.post_event(first).json()["alias"]["id"]
        customer_id = self.confirm_alias(alias_id).json()["alias"]["customer_id"]
        candidates = [first, self.create_candidate(), self.create_candidate()]
        occurred_dates = ["2026-01-01", "2026-02-15", "2026-03-31"]
        for candidate, occurred_on in zip(candidates, occurred_dates):
            response = self.post_event(candidate, occurred_on=occurred_on)
            self.assertEqual(response.status_code, 201, response.content)

        path = f"/api/customers/{customer_id}/evaluate"
        evaluated = self.client.post(
            path, data=json.dumps({"as_of": "2026-08-01"}), content_type="application/json"
        )
        self.assertEqual(evaluated.status_code, 200, evaluated.content)
        payload = evaluated.json()
        metrics = {row["metric_key"]: row for row in payload["metrics"]}
        self.assertEqual(Decimal(metrics["order_interval_median_days"]["value"]), Decimal("44.5"))
        self.assertEqual(Decimal(metrics["silence_days"]["value"]), Decimal("123"))
        self.assertEqual(metrics["silence_days"]["coverage"]["order_count"], 3)
        self.assertEqual(len(metrics["silence_days"]["input_event_ids"]), 3)
        self.assertEqual(payload["prediction"]["result"], "recommended")
        self.assertEqual(
            Decimal(payload["prediction"]["input_snapshot"]["rule"]["threshold_days"]),
            Decimal("66.75"),
        )
        self.assertEqual(payload["action"]["status"], "suggested")
        self.assertIn("123", payload["action"]["suggestion"])
        self.assertIn("44.5", payload["action"]["suggestion"])

        replay = self.client.post(
            path, data=json.dumps({"as_of": "2026-08-01"}), content_type="application/json"
        )
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["prediction"]["id"], payload["prediction"]["id"])
        self.assertEqual(replay.json()["action"]["id"], payload["action"]["id"])
        self.assertEqual(CustomerMetricSnapshot.objects.count(), 2)
        self.assertEqual(CustomerPrediction.objects.count(), 1)
        self.assertEqual(CustomerAction.objects.count(), 1)

        action_id = payload["action"]["id"]
        accepted = self.client.post(
            f"/api/customer-actions/{action_id}/decision",
            data=json.dumps({"decision": "accept", "note": "人工采纳"}),
            content_type="application/json",
        )
        self.assertEqual(accepted.status_code, 200, accepted.content)
        self.assertEqual(accepted.json()["action"]["status"], "accepted")
        completed = self.client.post(
            f"/api/customer-actions/{action_id}/decision",
            data=json.dumps({"decision": "complete", "note": "已人工处理"}),
            content_type="application/json",
        )
        self.assertEqual(completed.status_code, 200, completed.content)
        self.assertEqual(completed.json()["action"]["status"], "completed")
        invalid = self.client.post(
            f"/api/customer-actions/{action_id}/decision",
            data=json.dumps({"decision": "dismiss"}),
            content_type="application/json",
        )
        self.assertEqual(invalid.status_code, 409, invalid.content)

    def test_no_history_and_two_orders_do_not_generate_recommendation(self):
        customer = Customer.objects.create(display_name="Empty Customer")
        path = f"/api/customers/{customer.pk}/evaluate"
        empty = self.client.post(
            path, data=json.dumps({"as_of": "2026-08-01"}), content_type="application/json"
        )
        self.assertEqual(empty.status_code, 200, empty.content)
        self.assertTrue(all(row["value"] is None for row in empty.json()["metrics"]))
        self.assertEqual(empty.json()["prediction"]["result"], "insufficient_data")
        self.assertIsNone(empty.json()["action"])

        first = self.create_candidate("Two-Order-Customer")
        alias_id = self.post_event(first).json()["alias"]["id"]
        customer_id = self.confirm_alias(alias_id, "Two Order Customer").json()["alias"]["customer_id"]
        second = self.create_candidate("Two-Order-Customer")
        self.assertEqual(self.post_event(first).status_code, 201)
        self.assertEqual(self.post_event(second, occurred_on="2026-02-01").status_code, 201)
        response = self.client.post(
            f"/api/customers/{customer_id}/evaluate",
            data=json.dumps({"as_of": "2026-08-01"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIsNotNone(response.json()["metrics"][0]["value"])
        self.assertEqual(response.json()["prediction"]["result"], "insufficient_data")
        self.assertIsNone(response.json()["action"])

    def test_orders_older_than_one_year_remain_in_silence_history(self):
        first = self.create_candidate("Old-Customer")
        alias_id = self.post_event(first).json()["alias"]["id"]
        customer_id = self.confirm_alias(alias_id, "Old Customer").json()["alias"]["customer_id"]
        candidates = [first, self.create_candidate("Old-Customer"), self.create_candidate("Old-Customer")]
        for candidate, occurred_on in zip(candidates, ["2024-01-01", "2024-02-01", "2024-03-01"]):
            response = self.post_event(candidate, occurred_on=occurred_on)
            self.assertEqual(response.status_code, 201, response.content)
        response = self.client.post(
            f"/api/customers/{customer_id}/evaluate",
            data=json.dumps({"as_of": "2026-08-01"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        metrics = {row["metric_key"]: row for row in response.json()["metrics"]}
        self.assertEqual(metrics["silence_days"]["window_start"], "2024-01-01")
        self.assertGreater(Decimal(metrics["silence_days"]["value"]), Decimal("365"))
        self.assertEqual(response.json()["prediction"]["result"], "recommended")

    def test_analysis_reports_activity_and_source_coverage_without_fake_conversion(self):
        customer_id = self.create_customer_with_orders(
            "Analysis Customer", ["2026-01-01", "2026-02-15", "2026-03-31"]
        )
        quotation = self.create_candidate("Analysis Customer")
        self.assertEqual(
            self.post_event(quotation, occurred_on="2026-04-15", event_type="quotation").status_code,
            201,
        )
        response = self.client.get(f"/api/customers/{customer_id}/analysis?as_of=2026-08-01")
        self.assertEqual(response.status_code, 200, response.content)
        analysis = response.json()["analysis"]
        self.assertEqual(analysis["event_counts"]["order"], 3)
        self.assertEqual(analysis["event_counts"]["quotation"], 1)
        self.assertEqual(analysis["source_coverage"]["source_snapshot_count"], 4)
        self.assertEqual(Decimal(analysis["source_coverage"]["document_reference_coverage"]), Decimal("1"))
        self.assertEqual(analysis["source_coverage"]["operator_supplemented_date_count"], 4)
        april = next(row for row in analysis["monthly_activity"] if row["month"] == "2026-04")
        self.assertEqual(april["quotation_count"], 1)
        self.assertEqual(Decimal(analysis["order_intervals"]["median_days"]), Decimal("44.5"))
        self.assertNotIn("conversion", response.content.decode().lower())

    def test_backtest_truncates_history_and_marks_unobserved_windows_censored(self):
        customer_id = self.create_customer_with_orders(
            "Backtest Customer", ["2026-01-01", "2026-02-01", "2026-03-01", "2026-05-10"]
        )
        counts_before = (
            CustomerMetricSnapshot.objects.count(),
            CustomerPrediction.objects.count(),
            CustomerAction.objects.count(),
        )
        response = self.client.post(
            f"/api/customers/{customer_id}/backtest",
            data=json.dumps({"start": "2026-04-20", "end": "2026-05-15", "step_days": 366}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        backtest = response.json()["backtest"]
        self.assertEqual(len(backtest["rows"]), 2)
        first, second = backtest["rows"]
        self.assertEqual(first["result"], "recommended")
        self.assertEqual(first["order_count"], 3)
        self.assertEqual(first["outcome"], "order_placed")
        self.assertEqual(second["result"], "not_recommended")
        self.assertEqual(second["outcome"], "censored")
        self.assertEqual(backtest["summary"]["recommended_count"], 1)
        self.assertEqual(Decimal(backtest["summary"]["hit_rate"]), Decimal("1"))
        self.assertEqual(backtest["summary"]["censored_count"], 1)
        self.assertEqual(backtest["analysis_boundary"], "descriptive_backtest_not_causal")
        self.assertEqual(counts_before, (
            CustomerMetricSnapshot.objects.count(),
            CustomerPrediction.objects.count(),
            CustomerAction.objects.count(),
        ))

    def test_reconciliation_waits_for_observation_then_backfills_outcome(self):
        customer_id = self.create_customer_with_orders(
            "Reconcile Customer", ["2026-01-01", "2026-02-01", "2026-03-01", "2026-05-10"]
        )
        evaluated = self.client.post(
            f"/api/customers/{customer_id}/evaluate",
            data=json.dumps({"as_of": "2026-04-20"}),
            content_type="application/json",
        )
        self.assertEqual(evaluated.status_code, 200, evaluated.content)
        prediction_id = evaluated.json()["prediction"]["id"]
        early = self.client.post(
            f"/api/customers/{customer_id}/reconcile",
            data=json.dumps({"as_of": "2026-04-25"}),
            content_type="application/json",
        )
        self.assertEqual(early.status_code, 200, early.content)
        self.assertEqual(early.json()["reconciliation"]["resolved_count"], 0)
        self.assertEqual(early.json()["reconciliation"]["pending_count"], 1)
        resolved = self.client.post(
            f"/api/customers/{customer_id}/reconcile",
            data=json.dumps({"as_of": "2026-05-10"}),
            content_type="application/json",
        )
        self.assertEqual(resolved.status_code, 200, resolved.content)
        self.assertEqual(resolved.json()["reconciliation"]["resolved_count"], 1)
        prediction = CustomerPrediction.objects.get(pk=prediction_id)
        self.assertEqual(prediction.outcome, "order_placed")
        self.assertIsNotNone(prediction.resolved_at)
        replay = self.client.post(
            f"/api/customers/{customer_id}/reconcile",
            data=json.dumps({"as_of": "2026-05-10"}),
            content_type="application/json",
        )
        self.assertEqual(replay.json()["reconciliation"]["resolved_count"], 0)

    def test_event_and_metric_snapshots_are_append_only(self):
        candidate = self.create_candidate()
        alias_id = self.post_event(candidate).json()["alias"]["id"]
        customer_id = self.confirm_alias(alias_id).json()["alias"]["customer_id"]
        event_id = self.post_event(candidate).json()["event"]["id"]
        self.client.post(
            f"/api/customers/{customer_id}/evaluate",
            data=json.dumps({"as_of": "2026-08-01"}),
            content_type="application/json",
        )
        event = CustomerEvent.objects.get(pk=event_id)
        event.occurred_on = event.occurred_on.replace(day=2)
        with self.assertRaises(ValidationError):
            event.save()
        with self.assertRaises(ValidationError):
            CustomerEvent.objects.filter(pk=event_id).update(occurred_on=event.occurred_on)
        metric = CustomerMetricSnapshot.objects.first()
        with self.assertRaises(ValidationError):
            CustomerMetricSnapshot.objects.filter(pk=metric.pk).update(value=0)
