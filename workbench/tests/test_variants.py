from __future__ import annotations

import json

from django.test import TestCase


class VariantApiTests(TestCase):
    """机型主数据 API：创建/查询/更新与校验。"""

    def setUp(self):
        from workbench.models import MaterialItem
        for code, name in (("MAT-LED-001", "彩灯带"), ("MAT-CTRL-001", "主控制器")):
            MaterialItem.objects.get_or_create(item_code=code, defaults={
                "item_name": name, "item_group": "演示", "stock_uom": "个", "source": "demo_fixture",
            })

    def test_create_list_and_update_variant(self):
        created = self.client.post("/api/variants", data=json.dumps({
            "variant_code": "VAR-BOX-001",
            "name": "丝带礼盒套装",
            "components": [
                {"item_ref": "MAT-CTRL-001", "quantity": "1", "role": "main"},
                {"item_ref": "MAT-LED-001", "quantity": "2", "role": "optional"},
            ],
        }), content_type="application/json")
        self.assertEqual(created.status_code, 201, created.content)
        variant = created.json()["variant"]
        self.assertEqual(variant["variant_code"], "VAR-BOX-001")
        self.assertEqual([component["item_ref"] for component in variant["components"]],
                         ["MAT-CTRL-001", "MAT-LED-001"])
        self.assertEqual(variant["source"], "manual")

        listing = self.client.get("/api/variants").json()
        self.assertGreaterEqual(listing["total"], 1)
        listed = next(v for v in listing["variants"] if v["variant_code"] == "VAR-BOX-001")
        self.assertEqual(len(listed["components"]), 2)

        query = self.client.get("/api/variants?q=礼盒").json()
        self.assertEqual(query["total"], 1)
        miss = self.client.get("/api/variants?q=不存在").json()
        self.assertEqual(miss["total"], 0)

        updated = self.client.post("/api/variants/VAR-BOX-001/update", data=json.dumps({
            "name": "丝带礼盒套装（改）", "disabled": True,
            "components": [{"item_ref": "MAT-LED-001", "quantity": "3", "role": "main"}],
        }), content_type="application/json")
        self.assertEqual(updated.status_code, 200, updated.content)
        variant = updated.json()["variant"]
        self.assertEqual(variant["name"], "丝带礼盒套装（改）")
        self.assertTrue(variant["disabled"])
        self.assertEqual(variant["components"][0]["quantity"], "3")

    def test_duplicate_variant_code_is_rejected(self):
        body = json.dumps({"variant_code": "VAR-DUP-001", "name": "机型", "components": []})
        first = self.client.post("/api/variants", data=body, content_type="application/json")
        self.assertEqual(first.status_code, 201, first.content)
        second = self.client.post("/api/variants", data=body, content_type="application/json")
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json()["error_code"], "variant_exists")

    def test_component_validation_errors(self):
        bad_quantity = self.client.post("/api/variants", data=json.dumps({
            "variant_code": "VAR-BAD-001", "name": "机型",
            "components": [{"item_ref": "MAT-LED-001", "quantity": "0", "role": "main"}],
        }), content_type="application/json")
        self.assertEqual(bad_quantity.status_code, 422)
        self.assertEqual(bad_quantity.json()["error_code"], "invalid_components")

        bad_role = self.client.post("/api/variants", data=json.dumps({
            "variant_code": "VAR-BAD-002", "name": "机型",
            "components": [{"item_ref": "MAT-LED-001", "quantity": "1", "role": "sometimes"}],
        }), content_type="application/json")
        self.assertEqual(bad_role.status_code, 422)

        bad_ref = self.client.post("/api/variants", data=json.dumps({
            "variant_code": "VAR-BAD-003", "name": "机型",
            "components": [{"item_ref": "带空格 编号!", "quantity": "1"}],
        }), content_type="application/json")
        self.assertEqual(bad_ref.status_code, 422)

    def test_demo_seed_variant_exists_after_migration(self):
        from workbench.models import ProductVariant
        variant = ProductVariant.objects.filter(
            variant_code="DEMO-SAUNA-001", source="demo_fixture").first()
        self.assertIsNotNone(variant)
        self.assertEqual(variant.components.count(), 2)

    def test_update_missing_variant_is_404(self):
        response = self.client.post("/api/variants/NO-SUCH/update", data=json.dumps({
            "name": "x",
        }), content_type="application/json")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["error_code"], "variant_not_found")
