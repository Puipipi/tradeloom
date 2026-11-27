"""SKU 成本台账：核算口径、关税率匹配、期间费用与导出。

这些用例盯的都是「钱算得对不对」和「算不出来时有没有硬编数字」，
而不是页面长什么样——页面渲染由 ``test_pages`` 覆盖。
"""
from __future__ import annotations

import json

from django.test import Client, TestCase

from workbench.sku import service


class SkuLedgerCase(TestCase):
    def setUp(self):
        self.client = Client()

    # ---- 小工具：都走真实 HTTP 入口，避免测出一条只在函数层成立的路径 ----

    def configure(self, **patch):
        response = self.client.post(
            "/api/sku/settings",
            data=json.dumps({"settings": patch}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def push_catalog(self, *items):
        response = self.client.post(
            "/api/sku/catalog/push",
            data=json.dumps({"items": list(items)}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def set_duty(self, rows, market="US"):
        response = self.client.post(
            "/api/sku/duty",
            data=json.dumps({"market": market, "rows": rows}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def patch_costs(self, patch):
        response = self.client.post(
            "/api/sku/rows",
            data=json.dumps({"patch": patch}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content[:300])
        return response.json()

    def state(self):
        response = self.client.get("/api/sku")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def row(self, sku):
        return next(item for item in self.state()["rows"] if item["sku"] == sku)


class SkuLedgerComputeTests(SkuLedgerCase):
    def test_landed_cost_profit_and_breakeven_follow_the_documented_formula(self):
        """到岸成本按 CIF 计征；毛利扣佣金，不扣广告与退货（那两项是期间费用）。"""
        self.configure(market="US", fx_mode="manual", fx=7.2, rebate=0)
        self.push_catalog({"sku": "VFR-01", "name": "Velvet Ribbon", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%", "extra_rate": "0%"}])
        self.patch_costs({
            "VFR-01": {
                "price": "10", "cost_cny": "20", "freight_cny": "2",
                "commission": "15", "hs_code": "5806.32", "units": "100",
            },
        })

        row = self.row("VFR-01")

        self.assertEqual(row["status"], "可算")
        # 采购 20 + 头程 2 = 22 的 CIF 基数，6% → 1.32 关税，到岸 23.32
        self.assertAlmostEqual(row["duty_base"], 22.0, places=4)
        self.assertAlmostEqual(row["duty_cny"], 1.32, places=4)
        self.assertAlmostEqual(row["landed_cost"], 23.32, places=4)
        # 售价 10 USD × 7.2 = 72 CNY；佣金 15% = 10.80；毛利 72 − 23.32 − 10.80
        self.assertAlmostEqual(row["price_cny"], 72.0, places=4)
        self.assertAlmostEqual(row["commission_cny"], 10.8, places=4)
        self.assertAlmostEqual(row["profit"], 37.88, places=4)
        self.assertAlmostEqual(row["margin"], 37.88 / 72.0, places=4)
        # 保本价：到岸 ÷ (1 − 佣金率) ÷ 汇率
        self.assertAlmostEqual(row["bep_price"], 23.32 / 0.85 / 7.2, places=3)

    def test_export_rebate_lowers_goods_cost_before_duty(self):
        """出口退税先冲减货品成本，关税再按退税后的货值 + 头程计征。

        退税率按人习惯的百分数写（13），与佣金一样允许 13 / 0.13 / "13%"。
        """
        self.configure(market="US", fx_mode="manual", fx=7.2, rebate=13)
        self.push_catalog({"sku": "VFR-02", "name": "Velvet Ribbon 2", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%"}])
        self.patch_costs({
            "VFR-02": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32"},
        })

        row = self.row("VFR-02")

        # 20 − 20 ÷ 1.13 × 0.13 = 17.6991，退税额 2.3009
        self.assertAlmostEqual(row["unit_cost"], 20 - 20 / 1.13 * 0.13, places=4)
        self.assertAlmostEqual(row["duty_base"], row["unit_cost"] + 2, places=4)

    def test_missing_duty_rate_blocks_margin_instead_of_guessing_zero(self):
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "VFR-03", "name": "Velvet Ribbon 3", "active": True})
        self.patch_costs({
            "VFR-03": {"price": "10", "cost_cny": "20", "freight_cny": "2", "commission": "15"},
        })

        row = self.row("VFR-03")

        self.assertEqual(row["status"], "待补")
        self.assertIn("关税", row["missing_text"])
        # 算不出来就整段不出现，而不是给个 0 或空字符串让人误读成「不赚不亏」
        self.assertNotIn("profit", row)
        self.assertNotIn("margin", row)

    def test_zero_duty_is_a_recorded_fact_not_a_blank(self):
        """填 0 表示「确认零关税」，与「还没查」必须分开。"""
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "VFR-04", "name": "Velvet Ribbon 4", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "0%"}])
        self.patch_costs({
            "VFR-04": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32"},
        })

        row = self.row("VFR-04")

        self.assertEqual(row["status"], "可算")
        self.assertEqual(row["duty_cny"], 0)
        self.assertAlmostEqual(row["landed_cost"], 22.0, places=4)

    def test_price_recorded_in_another_currency_falls_back_to_pending(self):
        """切市场后币种变了，旧售价不能直接沿用（10 USD ≠ 10 EUR）。"""
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "VFR-05", "name": "Velvet Ribbon 5", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%"}])
        self.patch_costs({
            "VFR-05": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32"},
        })
        self.configure(market="EU", fx_mode="manual", fx=7.8)

        row = self.row("VFR-05")

        self.assertEqual(row["status"], "待补")
        self.assertEqual(row["price_prev"], 10.0)
        self.assertEqual(row["price_prev_currency"], "USD")


class SkuDutyMatchingTests(TestCase):
    def test_longest_prefix_wins(self):
        duty_map = {"5806": 0.06, "5806.32": 0.075}

        rate, source = service.match_duty("5806.32.10", duty_map, "US")

        self.assertAlmostEqual(rate, 0.075)
        self.assertIn("5806.32", source)

    def test_unknown_market_rate_returns_reason_instead_of_number(self):
        rate, source = service.match_duty("6307.90", {}, "US")

        self.assertIsNone(rate)
        self.assertIn("未设税率", source)

    def test_free_port_market_defaults_to_zero(self):
        rate, source = service.match_duty("5806.32", {}, "HK")

        self.assertEqual(rate, 0.0)
        self.assertIn("默认", source)


class SkuPeriodCostTests(SkuLedgerCase):
    def test_period_expense_is_subtracted_at_summary_not_per_unit(self):
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "VFR-10", "name": "Velvet Ribbon 10", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%"}])
        self.patch_costs({
            "VFR-10": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32", "units": "100"},
        })

        before = self.state()["period"]
        response = self.client.post(
            "/api/sku/period",
            data=json.dumps({"month": before["month"], "patch": {"ad_spend_cny": "300"}}),
            content_type="application/json",
        )
        summary = response.json()["state"]["period"]["summary"]

        # 单件毛利不受期间费用影响，只有汇总层的经营净利变了
        self.assertEqual(self.row("VFR-10")["profit"], 37.88)
        self.assertAlmostEqual(summary["gross_profit"], 3788.0, places=2)
        self.assertAlmostEqual(summary["net_profit"], 3488.0, places=2)

    def test_unregistered_items_keep_net_profit_as_an_upper_bound(self):
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "VFR-11", "name": "Velvet Ribbon 11", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%"}])
        self.patch_costs({
            "VFR-11": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32", "units": "100"},
        })

        month = self.state()["period"]["month"]
        response = self.client.post(
            "/api/sku/period",
            data=json.dumps({"month": month, "patch": {"ad_spend_cny": "300"}}),
            content_type="application/json",
        )
        summary = response.json()["state"]["period"]["summary"]

        # 退货与月费没登记：净利只会更少，所以标 missing，页面显示成「≤」
        self.assertIn("退货损失", summary["missing"])
        self.assertIn("店铺月费", summary["missing"])


class SkuLedgerPageTests(SkuLedgerCase):
    def test_catalog_names_are_escaped_on_the_page(self):
        """清单来自官网推送，商品名是不可信输入，页面必须原样转义。"""
        self.push_catalog({"sku": "ESC-1", "name": "<script>alert(1)</script>", "active": True})

        response = self.client.get("/products")
        body = response.content.decode()

        self.assertEqual(response.status_code, 200)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", body)
        self.assertNotIn("<script>alert(1)</script>", body)

    def test_empty_catalog_still_renders_the_ledger_with_an_import_entry(self):
        response = self.client.get("/products")
        body = response.content.decode()

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'data-testid="sku-panel"')
        self.assertContains(response, 'id="sku-k-total">0<')
        self.assertContains(response, "导入商品清单")
        # 老产品资料库的空态文案不再出现
        self.assertNotContains(response, "尚未导入产品资料")


class SkuLedgerApiTests(SkuLedgerCase):
    def test_export_follows_the_same_filter_as_the_page(self):
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog(
            {"sku": "OK-1", "name": "正常款", "active": True},
            {"sku": "LOSS-1", "name": "亏损款", "active": True},
        )
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%"}])
        self.patch_costs({
            "OK-1": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                     "commission": "15", "hs_code": "5806.32"},
            "LOSS-1": {"price": "3", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32"},
        })

        response = self.client.get("/api/sku/export.csv?state=loss")
        body = response.content.decode("utf-8-sig")

        self.assertEqual(response.status_code, 200)
        self.assertIn("LOSS-1", body)
        self.assertNotIn("OK-1", body)
        self.assertIn('filename="sku-cost-ledger.csv"', response["Content-Disposition"])

    def test_cost_csv_import_only_touches_known_skus(self):
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "KNOWN-1", "name": "已知款", "active": True})

        response = self.client.post(
            "/api/sku/import",
            data=json.dumps({"csv": "sku,售价USD,采购价CNY\nKNOWN-1,9.9,18\nGHOST-1,1,2\n"}),
            content_type="application/json",
        )
        result = response.json()["result"]

        self.assertEqual(result["matched"], 1)
        self.assertEqual(result["unknown_sku"], ["GHOST-1"])
        self.assertAlmostEqual(self.row("KNOWN-1")["price"], 9.9, places=4)

    def test_advice_compares_export_markets_and_skips_the_domestic_one(self):
        self.configure(market="US", fx_mode="manual", fx=7.2)
        self.push_catalog({"sku": "VFR-20", "name": "Velvet Ribbon 20", "active": True})
        self.set_duty([{"hs_prefix": "5806", "base_rate": "6%"}])
        self.patch_costs({
            "VFR-20": {"price": "10", "cost_cny": "20", "freight_cny": "2",
                       "commission": "15", "hs_code": "5806.32", "units": "100"},
        })

        payload = self.client.get("/api/sku/advice").json()["advice"]

        codes = [item["code"] for item in payload["markets"]]
        self.assertNotIn("CN", codes)
        self.assertIn("US", codes)
        self.assertEqual(
            set(payload),
            # has_demand / coverage 是需求侧接入后新增的：一个给前端判断「要不要提示去同步」，
            # 一个给选品页显示「几个编码有数据」。老字段一个没少。
            {"month", "current_market", "current_name", "headline", "hint",
             "has_demand", "coverage", "markets", "suggestions"},
        )
        # 香港是默认零关税，只能作参考：必须带 assumed_zero 标出来
        hk = next((item for item in payload["markets"] if item["code"] == "HK"), None)
        if hk is not None:
            self.assertTrue(hk["assumed_zero"])
