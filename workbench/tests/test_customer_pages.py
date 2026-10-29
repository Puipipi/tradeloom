from __future__ import annotations

import json

from django.test import TestCase

from workbench.tests.test_customer_knowledge import CustomerFixtureMixin


class CustomerPageTests(CustomerFixtureMixin, TestCase):
    def test_list_shows_pending_alias_candidate_form_and_navigation(self):
        candidate = self.create_candidate("Page Pending Customer")
        pending = self.post_event(candidate)
        self.assertEqual(pending.status_code, 202, pending.content)

        response = self.client.get("/customers")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="nav-customers"')
        self.assertContains(response, 'data-testid="candidate-event-form"')
        self.assertContains(response, "Page Pending Customer")
        self.assertContains(response, "确认并新建客户")
        self.assertContains(response, "系统不会按相似名称自动合并")

    def test_list_and_detail_render_real_analysis_and_action_states(self):
        customer_id = self.create_customer_with_orders(
            "Page Customer", ["2026-01-01", "2026-02-15", "2026-03-31"]
        )
        evaluated = self.client.post(
            f"/api/customers/{customer_id}/evaluate",
            data=json.dumps({"as_of": "2026-08-01"}),
            content_type="application/json",
        )
        self.assertEqual(evaluated.status_code, 200, evaluated.content)

        listing = self.client.get("/customers")
        self.assertContains(listing, "Page Customer")
        self.assertContains(listing, f'href="/customers/{customer_id}"')
        self.assertContains(listing, "1 条")

        detail = self.client.get(f"/customers/{customer_id}?as_of=2026-08-01")
        self.assertEqual(detail.status_code, 200)
        self.assertContains(detail, 'data-testid="analysis-event-count">3<')
        self.assertContains(detail, "44.5")
        self.assertContains(detail, "123")
        self.assertContains(detail, "采纳")
        self.assertNotContains(detail, ">完成</button>")
        self.assertContains(detail, "放弃")
        self.assertContains(detail, 'data-testid="monthly-activity"')
        self.assertContains(detail, "工作表 1 · A1")
        self.assertContains(detail, "operator_supplement")
        self.assertContains(detail, "描述性回测不证明")

        self.client.post(
            f"/api/customer-actions/{evaluated.json()['action']['id']}/decision",
            data=json.dumps({"decision": "accept", "note": "页面测试采纳"}),
            content_type="application/json",
        )
        accepted = self.client.get(f"/customers/{customer_id}?as_of=2026-08-01")
        self.assertContains(accepted, "已采纳")
        self.assertContains(accepted, ">完成</button>")
        self.assertNotContains(accepted, ">采纳</button>")

    def test_detail_rejects_invalid_date_with_visible_fallback(self):
        customer_id = self.create_customer_with_orders("Date Customer", ["2026-01-01"])
        response = self.client.get(f"/customers/{customer_id}?as_of=not-a-date")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "评估日期无效，已改用今天。")

    def test_home_navigation_links_customer_page(self):
        response = self.client.get("/home")
        self.assertContains(response, 'data-testid="nav-customers"')
        self.assertContains(response, 'href="/customers"')
