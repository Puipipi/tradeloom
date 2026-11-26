"""UN Comtrade 需求侧：指标口径、HS 来源、分批同步、选品建议的需求加权。

这些用例盯的是「数算得对不对」和「没数据时有没有硬编一个数」：
需求侧最容易出的错不是算法，而是把「还没同步」当成「没有进口」，
或者把章节合计当成某个 SKU 的量。
"""
from __future__ import annotations

import json
from unittest import mock

from django.test import Client, TestCase

from workbench.trade import advice as advice_module
from workbench.trade import client, service, store


def world_china(hs6, reporter, year, world_value, china_value, weight=None):
    """构造一对「世界合计 / 中国」观测，省得每个用例写两遍字典。"""
    rows = [
        {
            "hs6": hs6, "reporter_code": reporter, "partner_code": 0, "flow": "M",
            "period": year, "primary_value": world_value,
            "net_wgt": weight, "qty": None, "qty_unit": "",
        },
        {
            "hs6": hs6, "reporter_code": reporter, "partner_code": 156, "flow": "M",
            "period": year, "primary_value": china_value,
            "net_wgt": None, "qty": None, "qty_unit": "",
        },
    ]
    return rows


class TradeMetricsCase(TestCase):
    def setUp(self):
        self.records = (
            world_china("580632", 842, 2025, 250_000_000, 25_000_000, 25_000_000)
            + world_china("580632", 842, 2024, 200_000_000, 20_000_000, 20_000_000)
        )

    def test_hs6_normalisation_keeps_six_digits(self):
        self.assertEqual(client.normalize_hs6("5806.32"), "580632")
        self.assertEqual(client.normalize_hs6("5806321010"), "580632")
        # 4 位是章级别：查回来是整章的贸易额，和具体商品无关
        self.assertIsNone(client.normalize_hs6("5806"))
        self.assertIsNone(client.normalize_hs6(""))

    def test_metrics_use_world_total_china_share_and_yoy(self):
        cell = service.market_metrics(self.records, "US")
        self.assertEqual(cell["source_year"], 2025)
        self.assertAlmostEqual(cell["import_value"], 250_000_000, places=2)
        # 中国 2500 万 ÷ 世界 2.5 亿 = 10%
        self.assertAlmostEqual(cell["cn_share"], 0.1, places=4)
        # 对上年 +25%
        self.assertAlmostEqual(cell["growth"], 0.25, places=4)
        # 2.5 亿 ÷ 2500 万 kg = 10 USD/kg
        self.assertAlmostEqual(cell["unit_price"], 10.0, places=2)
        self.assertEqual(cell["level"], "mid")

    def test_unsynced_market_is_none_not_zero(self):
        """没同步 ≠ 没进口。前者返回 None，页面写「未同步」；后者才写 0。"""
        self.assertIsNone(service.market_metrics(self.records, "GB"))

    def test_eu_aggregates_five_reporters(self):
        rows = (
            world_china("580632", 276, 2025, 100_000_000, 10_000_000, 10_000_000)
            + world_china("580632", 250, 2025, 50_000_000, 5_000_000, 5_000_000)
        )
        cell = service.market_metrics(rows, "EU")
        self.assertAlmostEqual(cell["import_value"], 150_000_000, places=2)
        self.assertAlmostEqual(cell["cn_share"], 0.1, places=4)
        self.assertEqual(cell["reporter_count"], 5)

    def test_missing_weight_leaves_unit_price_empty(self):
        rows = world_china("580632", 842, 2025, 250_000_000, 25_000_000, None)
        cell = service.market_metrics(rows, "US")
        self.assertIsNone(cell["unit_price"])
        self.assertEqual(cell["unit_price_text"], "—")

    def test_demand_levels_by_annual_value(self):
        self.assertEqual(service.demand_level(500_000_000)[0], "big")
        self.assertEqual(service.demand_level(50_000_000)[0], "mid")
        self.assertEqual(service.demand_level(3_000_000)[0], "small")
        self.assertEqual(service.demand_level(0)[0], "none")
        self.assertEqual(service.demand_level(None)[0], "none")


class TradeSyncCase(TestCase):
    def test_sync_batches_and_returns_cursor(self):
        """一次只跑 max_calls 组，交回 next_offset；前端据此续跑。"""
        fetched = world_china("580632", 842, 2025, 1_000_000, 100_000, 1_000)
        with mock.patch.object(client, "fetch", return_value=fetched) as fake:
            first = store.sync(hs6_list=["580632", "630790"], years=[2025, 2024],
                               offset=0, max_calls=2)
            self.assertEqual(first["total"], 4)
            self.assertEqual(first["next_offset"], 2)
            self.assertFalse(first["done"])
            self.assertEqual(fake.call_count, 2)
            self.assertEqual(first["observations"], 4)

            second = store.sync(hs6_list=["580632", "630790"], years=[2025, 2024],
                                offset=2, max_calls=2)
            self.assertTrue(second["done"])

    def test_sync_keeps_old_rows_when_upstream_fails(self):
        """中途失败不能把已有数据删掉——页面会突然白掉。"""
        store.save_records(world_china("580632", 842, 2025, 9_000_000, 1_000_000, 900))
        with mock.patch.object(client, "fetch", side_effect=client.TradeError("trade_unavailable")):
            result = store.sync(hs6_list=["580632"], years=[2024], offset=0, max_calls=1)
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(store.load_records(["580632"])[0]["period"], 2025)

    def test_upsert_overwrites_same_observation(self):
        row = world_china("580632", 842, 2025, 1_000, 100, 10)[0]
        store.save_records([row])
        row["primary_value"] = 2_000
        store.save_records([row])
        stored = store.load_records(["580632"])
        self.assertEqual(len(stored), 1)
        self.assertEqual(float(stored[0]["primary_value"]), 2_000)


class TradeApiCase(TestCase):
    def setUp(self):
        self.client = Client()

    def configure_duty(self, rows, market="US"):
        response = self.client.post(
            "/api/sku/duty",
            data=json.dumps({"market": market, "rows": rows}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content[:300])

    def test_state_falls_back_to_duty_prefix_when_ledger_has_no_hs(self):
        """台账里逐 SKU 的 HS 还没填时，关税表里的编码仍然要能查。"""
        self.configure_duty([{"hs_prefix": "5806.32", "base_rate": "6%"}])
        payload = self.client.get("/api/trade").json()
        self.assertEqual([item["hs6"] for item in payload["hs6"]], ["580632"])
        entry = payload["hs6"][0]
        self.assertEqual(entry["source"], "duty")
        self.assertEqual(entry["sku_count"], 0)
        self.assertEqual(entry["duty_markets"], ["US"])

    def test_state_reports_invalid_short_codes(self):
        self.client.post(
            "/api/sku/catalog/push",
            data=json.dumps({"items": [{"sku": "VFR-20", "name": "Ribbon", "active": True}]}),
            content_type="application/json",
        )
        self.client.post(
            "/api/sku/rows",
            data=json.dumps({"patch": {"VFR-20": {"hs_code": "5806"}}}),
            content_type="application/json",
        )
        payload = self.client.get("/api/trade").json()
        self.assertEqual(payload["hs6"], [])
        self.assertEqual([item["sku"] for item in payload["invalid"]], ["VFR-20"])

    def test_sync_without_hs6_returns_error_code(self):
        response = self.client.post(
            "/api/trade/sync",
            data=json.dumps({"offset": 0, "max_calls": 1}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error_code"], "no_hs6")

    def test_settings_never_echo_the_key_back(self):
        response = self.client.post(
            "/api/trade/settings",
            data=json.dumps({"settings": {"api_key": "secret-key", "lookback_years": 2}}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["settings"]["has_key"])
        self.assertEqual(response.json()["settings"]["lookback_years"], 2)
        # 状态里只回「有没有 key」，不回 key 本身
        self.assertNotIn("secret-key", response.content.decode())


class AdviceDemandCase(TestCase):
    """需求侧对建议的影响：只降权，不改毛利；没量要单独成一类。"""

    def build_inputs(self):
        row = {"sku": "VFR-20", "status": "可算", "profit": 30.0, "margin": 0.42,
               "units": 100, "price": 10.0, "bep_price": 6.0, "name": "Ribbon"}
        return {
            "month": "2026-11",
            # 当前在港卖（毛利 12），美国毛利 30：结论是「换去美国」，
            # 至于该不该换，就看美国有没有量。
            "current_market": "HK",
            "markets": [
                {"code": "US", "name": "美国", "currency": "USD", "assumed_zero": False, "rows": [row]},
                {"code": "HK", "name": "中国香港", "currency": "HKD", "assumed_zero": False,
                 "rows": [dict(row, profit=12.0, margin=0.2)]},
            ],
            "skus": [{"sku": "VFR-20", "name": "Ribbon", "active": True}],
        }

    def demand_for(self, value):
        records = world_china("580632", 842, 2025, value, value * 0.1, value / 10)
        cell = service.market_metrics(records, "US")
        return {"580632": {"US": cell}}

    def test_no_demand_is_flagged_instead_of_switch(self):
        """美国毛利是香港的 2.5 倍，但那里一年只进口 100 万美元：不能说「换过去」。"""
        advice = advice_module.build_advice(
            self.build_inputs(), self.demand_for(1_000_000), {"VFR-20": "580632"}, ["580632"],
        )
        kinds = [item["kind"] for item in advice["suggestions"]]
        self.assertIn("no_demand", kinds)
        self.assertNotIn("switch", kinds)
        item = next(item for item in advice["suggestions"] if item["kind"] == "no_demand")
        self.assertIn("100 万美元", item["text"])
        self.assertEqual(item["market"], "US")

    def test_switch_keeps_cost_conclusion_when_demand_is_healthy(self):
        advice = advice_module.build_advice(
            self.build_inputs(), self.demand_for(500_000_000), {"VFR-20": "580632"}, ["580632"],
        )
        kinds = [item["kind"] for item in advice["suggestions"]]
        self.assertIn("switch", kinds)
        self.assertNotIn("no_demand", kinds)

    def test_market_without_demand_data_is_not_demoted(self):
        """没同步过贸易数据时按「未知」处理，不能当成没量压到最后。"""
        advice = advice_module.build_advice(self.build_inputs(), {}, {"VFR-20": "580632"}, [])
        flags = {item["code"]: item["demand_flag"] for item in advice["markets"]}
        # 2 = 未知，1 = 量小，0 = 没进口：没数据必须落在「未知」这一档
        self.assertEqual(flags["US"], 2)
        self.assertFalse(advice["has_demand"])

    def test_advice_payload_shape_is_stable(self):
        """接口字段只增不减：前端与外部脚本都在读这几个键。"""
        client_ = Client()
        payload = client_.get("/api/sku/advice").json()["advice"]
        for key in ("month", "current_market", "current_name", "headline", "hint",
                    "has_demand", "markets", "suggestions", "coverage"):
            self.assertIn(key, payload)
