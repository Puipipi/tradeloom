from __future__ import annotations

import json

from django.test import TestCase

from workbench.models import (
    Customer,
    CustomerAlias,
    CustomerAliasDecision,
    CustomerEvent,
    CustomerMerge,
    CustomerPrediction,
)
from workbench.tests.test_customer_knowledge import CustomerFixtureMixin


class CustomerIdentityGovernanceTests(CustomerFixtureMixin, TestCase):
    def test_pending_alias_can_be_confirmed_to_existing_customer(self):
        existing = Customer.objects.create(display_name="Existing Customer")
        candidate = self.create_candidate("Existing Customer Alias")
        alias_id = self.post_event(candidate).json()["alias"]["id"]

        response = self.client.post(
            f"/api/customer-aliases/{alias_id}/decision",
            data=json.dumps({"decision": "confirm", "customer_id": existing.pk}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["alias"]["customer_id"], existing.pk)
        self.assertEqual(Customer.objects.count(), 1)
        decision = CustomerAliasDecision.objects.get(alias_id=alias_id)
        self.assertEqual(decision.decision, "confirmed")
        self.assertIsNone(decision.from_customer)
        self.assertEqual(decision.to_customer_id, existing.pk)

    def test_alias_reassignment_only_changes_future_event_ownership(self):
        source_id = self.create_customer_with_orders("Reassign Customer", ["2026-01-01"])
        target = Customer.objects.create(display_name="Reassigned Target")
        alias = CustomerAlias.objects.get(customer_id=source_id)
        old_event = CustomerEvent.objects.get(customer_id=source_id)

        response = self.client.post(
            f"/api/customer-aliases/{alias.pk}/reassign",
            data=json.dumps({"customer_id": target.pk, "note": "人工确认新归属"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        alias.refresh_from_db()
        old_event.refresh_from_db()
        self.assertEqual(alias.customer_id, target.pk)
        self.assertEqual(old_event.customer_id, source_id)
        decision = CustomerAliasDecision.objects.get(alias=alias, decision="reassigned")
        self.assertEqual(decision.from_customer_id, source_id)
        self.assertEqual(decision.to_customer_id, target.pk)

        new_candidate = self.create_candidate("Reassign Customer")
        recorded = self.post_event(new_candidate, occurred_on="2026-02-01")
        self.assertEqual(recorded.status_code, 201, recorded.content)
        self.assertEqual(recorded.json()["event"]["customer_id"], target.pk)
        source_analysis = self.client.get(f"/api/customers/{source_id}/analysis?as_of=2026-08-01")
        target_analysis = self.client.get(f"/api/customers/{target.pk}/analysis?as_of=2026-08-01")
        self.assertEqual(source_analysis.json()["analysis"]["activity"]["order_count"], 1)
        self.assertEqual(target_analysis.json()["analysis"]["activity"]["order_count"], 1)

    def test_customer_merge_preserves_history_and_expands_family_analysis(self):
        source_id = self.create_customer_with_orders(
            "Merge Source", ["2026-01-01", "2026-02-01", "2026-03-01"]
        )
        target_id = self.create_customer_with_orders("Merge Target", ["2026-04-01"])
        source_alias = CustomerAlias.objects.get(customer_id=source_id)
        source_event_ids = set(CustomerEvent.objects.filter(customer_id=source_id).values_list("id", flat=True))
        evaluated = self.client.post(
            f"/api/customers/{source_id}/evaluate",
            data=json.dumps({"as_of": "2026-04-20"}),
            content_type="application/json",
        )
        prediction_id = evaluated.json()["prediction"]["id"]

        response = self.client.post(
            f"/api/customers/{target_id}/merge",
            data=json.dumps({"source_customer_id": source_id, "note": "同一企业历史名称"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200, response.content)
        merge_id = response.json()["merge"]["id"]
        source = Customer.objects.get(pk=source_id)
        source_alias.refresh_from_db()
        self.assertEqual(source.merged_into_id, target_id)
        self.assertIsNotNone(source.merged_at)
        self.assertEqual(source_alias.customer_id, target_id)
        self.assertTrue(CustomerAliasDecision.objects.filter(
            alias=source_alias,
            decision="merged",
            from_customer_id=source_id,
            to_customer_id=target_id,
        ).exists())
        self.assertEqual(CustomerMerge.objects.count(), 1)
        self.assertEqual(
            set(CustomerEvent.objects.filter(customer_id=source_id).values_list("id", flat=True)),
            source_event_ids,
        )
        self.assertEqual(CustomerPrediction.objects.get(pk=prediction_id).customer_id, source_id)

        analysis = self.client.get(f"/api/customers/{target_id}/analysis?as_of=2026-08-01")
        self.assertEqual(analysis.status_code, 200, analysis.content)
        payload = analysis.json()["analysis"]
        self.assertEqual(payload["activity"]["order_count"], 4)
        self.assertEqual(payload["prediction_outcomes"]["pending"], 1)
        detail = self.client.get(f"/api/customers/{target_id}")
        self.assertEqual(set(detail.json()["customer"]["customer_family_ids"]), {source_id, target_id})
        self.assertEqual(len(detail.json()["customer"]["events"]), 4)

        redirected = self.client.get(f"/customers/{source_id}")
        self.assertEqual(redirected.status_code, 302)
        self.assertEqual(redirected.url, f"/customers/{target_id}")
        listing = self.client.get("/customers")
        self.assertNotIn(source_id, [row.pk for row in listing.context["customers"]])

        replay = self.client.post(
            f"/api/customers/{target_id}/merge",
            data=json.dumps({"source_customer_id": source_id, "note": "同一企业历史名称"}),
            content_type="application/json",
        )
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["merge"]["id"], merge_id)
        self.assertEqual(CustomerMerge.objects.count(), 1)

    def test_merge_rejects_self_and_already_merged_source(self):
        target_id = self.create_customer_with_orders("Merge Boundary", ["2026-01-01"])
        self_merge = self.client.post(
            f"/api/customers/{target_id}/merge",
            data=json.dumps({"source_customer_id": target_id}),
            content_type="application/json",
        )
        self.assertEqual(self_merge.status_code, 422)
        self.assertEqual(self_merge.json()["error_code"], "invalid_customer_merge")

        other_id = self.create_customer_with_orders("Other Merge", ["2026-02-01"])
        self.client.post(
            f"/api/customers/{target_id}/merge",
            data=json.dumps({"source_customer_id": other_id}),
            content_type="application/json",
        )
        third_id = self.create_customer_with_orders("Third Merge", ["2026-03-01"])
        rejected = self.client.post(
            f"/api/customers/{third_id}/merge",
            data=json.dumps({"source_customer_id": other_id}),
            content_type="application/json",
        )
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["error_code"], "customer_already_merged")

    def test_detail_exposes_reassignment_and_merge_controls(self):
        source_id = self.create_customer_with_orders("Identity Controls", ["2026-01-01"])
        Customer.objects.create(display_name="Identity Target")
        response = self.client.get(f"/customers/{source_id}")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="customer-merge-form"')
        self.assertContains(response, "改派别名")
        self.assertContains(response, "Identity Target")
        self.assertContains(response, "只影响改派后的新事件")
