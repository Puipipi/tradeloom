from __future__ import annotations

import json
import unittest

from django.test import SimpleTestCase

from workbench.materials.catalog import MaterialItem, material_items
from workbench.materials.resolver import normalize_reference, resolve_reference
from workbench.materials.rules import (
    BLOCKING,
    CONFIRM,
    check_requirement,
    evaluate_line,
    evaluate_lines,
    material_check,
)


class ResolveTests(unittest.TestCase):
    def test_item_code_is_case_insensitive(self):
        result = resolve_reference("mat-ctrl-001")
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.match, "item_code")
        self.assertEqual(result.item.item_code, "MAT-CTRL-001")

    def test_alias_resolves(self):
        result = resolve_reference("主控板")
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.match, "alias")
        self.assertEqual(result.item.item_code, "MAT-CTRL-001")

    def test_item_name_resolves(self):
        result = resolve_reference("彩灯带")
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.match, "item_name")

    def test_typed_item_reference_resolves(self):
        result = resolve_reference({"doctype": "Item", "name": "氧吧"})
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.item.item_code, "MAT-OXY-001")

    def test_unsupported_doctype_is_rejected(self):
        result = resolve_reference({"doctype": "Customer", "name": "主控制器"})
        self.assertEqual(result.status, "unresolved")
        self.assertEqual(result.reason, "unsupported_doctype")

    def test_blank_reference_is_empty(self):
        for value in ("", "   ", None, {"doctype": "Item", "name": ""}):
            with self.subTest(value=value):
                result = resolve_reference(value)
                self.assertEqual(result.status, "unresolved")
                self.assertEqual(result.reason, "empty")

    def test_unknown_reference_returns_no_candidates(self):
        result = resolve_reference("不存在的物料")
        self.assertEqual(result.status, "unresolved")
        self.assertEqual(result.reason, "not_found")
        self.assertEqual(result.candidates, ())

    def test_partial_text_is_not_silently_resolved(self):
        result = resolve_reference("彩灯")
        self.assertEqual(result.status, "resolved")
        result = resolve_reference("灯")
        self.assertEqual(result.status, "unresolved")
        self.assertEqual([item.item_code for item in result.candidates], ["MAT-LED-001"])

    def test_two_hits_are_ambiguous(self):
        result = resolve_reference("控制")
        self.assertEqual(result.status, "ambiguous")
        self.assertEqual(
            [item.item_code for item in result.candidates],
            ["MAT-CTRL-001", "MAT-CTRL-002"],
        )

    def test_disabled_item_still_resolves(self):
        result = resolve_reference("门封条")
        self.assertEqual(result.status, "resolved")
        self.assertTrue(result.item.disabled)

    def test_fullwidth_and_space_normalization(self):
        self.assertEqual(normalize_reference("ＭＰ３ 播放器"), "mp3播放器")
        result = resolve_reference("ＭＰ３播放器")
        self.assertEqual(result.status, "resolved")
        self.assertEqual(result.item.item_code, "MAT-AUD-001")


class RuleTests(unittest.TestCase):
    def test_unknown_item_is_blocking(self):
        check = evaluate_line(ref="line:1", reference="外星材料", quantity="2", unit="个")
        keys = [issue.issue_key for issue in check.issues]
        self.assertEqual(keys, ["unknown_item"])
        self.assertEqual(check.issues[0].severity, BLOCKING)

    def test_ambiguous_item_lists_options(self):
        check = evaluate_line(ref="line:1", reference="控制", quantity="1", unit="台")
        issue = check.issues[0]
        self.assertEqual(issue.issue_key, "ambiguous_item")
        self.assertEqual(len(issue.options), 2)

    def test_missing_item_is_confirm_only(self):
        check = evaluate_line(ref="line:1", reference=None, quantity="1", unit="台")
        self.assertEqual(check.issues[0].issue_key, "missing_item")
        self.assertEqual(check.issues[0].severity, CONFIRM)

    def test_unit_mismatch_is_confirm(self):
        check = evaluate_line(ref="line:1", reference="主控制器", quantity="1", unit="件")
        keys = [issue.issue_key for issue in check.issues]
        self.assertEqual(keys, ["unit_mismatch"])
        self.assertEqual(check.issues[0].severity, CONFIRM)

    def test_unit_whitespace_is_normalized(self):
        check = evaluate_line(ref="line:1", reference="主控制器", quantity="1", unit=" 台 ")
        self.assertEqual(check.issues, ())

    def test_disabled_item_blocks(self):
        check = evaluate_line(ref="line:1", reference="门封条", quantity="3", unit="米")
        self.assertEqual([issue.issue_key for issue in check.issues], ["disabled_item"])

    def test_quantity_rules(self):
        cases = {
            None: "missing_quantity",
            "abc": "invalid_quantity",
            "0": "quantity_not_positive",
            "-1": "invalid_quantity",
            "2.5": None,
        }
        for quantity, expected in cases.items():
            with self.subTest(quantity=quantity):
                check = evaluate_line(ref="line:1", reference="彩灯带", unit="米", quantity=quantity)
                keys = [issue.issue_key for issue in check.issues]
                self.assertEqual(keys, [expected] if expected else [])

    def test_lines_get_stable_refs(self):
        checks = evaluate_lines([
            {"description": "彩灯带", "quantity": "2", "unit": "米"},
            {"ref": "orders:9", "description": "木材", "quantity": "1", "unit": "根"},
        ])
        self.assertEqual([check.ref for check in checks], ["line:1", "orders:9"])

    def test_requirement_check_reads_requirement_fields(self):
        check = check_requirement(
            {"item_ref": {"doctype": "Item", "name": "主控制器"}, "quantity": "4", "unit": "台"},
            ref="requirement:abc",
        )
        self.assertEqual(check.ref, "requirement:abc")
        self.assertEqual(check.issues, ())

    def test_catalog_matches_declared_shape(self):
        codes = [item.item_code for item in material_items()]
        self.assertEqual(len(codes), len(set(codes)))
        for item in material_items():
            self.assertIsInstance(item, MaterialItem)
            self.assertTrue(item.item_code and item.item_name and item.stock_uom)

    def test_material_check_states(self):
        passed = material_check({"item_ref": {"doctype": "Item", "name": "主控制器"}, "quantity": "4", "unit": "台"})
        self.assertEqual(passed["state"], "passed")
        self.assertEqual(passed["source"], "demo_fixture")
        blocked = material_check({"item_ref": {"doctype": "Item", "name": "外星材料"}, "quantity": "1", "unit": "个"})
        self.assertEqual(blocked["state"], "blocked")
        confirm = material_check({"item_ref": None, "quantity": "1", "unit": "台"})
        self.assertEqual(confirm["state"], "needs_confirmation")


class MaterialsApiTests(SimpleTestCase):
    def test_status_reports_demo_source(self):
        response = self.client.get("/api/materials/status")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source"], "demo_fixture")
        self.assertGreater(payload["item_count"], 0)
        self.assertFalse(payload["erpnext_configured"])
        self.assertIn("演示", payload["disclaimer"])

    def test_status_rejects_arguments(self):
        self.assertEqual(self.client.get("/api/materials/status?x=1").status_code, 422)

    def test_items_search(self):
        response = self.client.get("/api/materials/items?q=灯")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual([item["item_code"] for item in payload["items"]], ["MAT-LED-001"])

    def test_items_reject_bad_limit(self):
        for query in ("?limit=0", "?limit=99", "?limit=abc", "?q=a&q=b"):
            with self.subTest(query=query):
                self.assertEqual(self.client.get(f"/api/materials/items{query}").status_code, 422)

    def test_check_resolves_and_reports_issues(self):
        body = {"lines": [
            {"ref": "order:1", "description": "彩灯带", "quantity": "12", "unit": "米"},
            {"ref": "order:2", "description": "外星材料", "quantity": "1", "unit": "个"},
        ]}
        response = self.client.post("/api/materials/check", json.dumps(body), content_type="application/json")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["summary"]["checked"], 2)
        self.assertEqual(payload["summary"]["resolved"], 1)
        self.assertEqual(payload["summary"]["blocking"], 1)
        self.assertEqual([issue["issue_key"] for issue in payload["issues"]], ["unknown_item"])

    def test_check_rejects_unknown_fields(self):
        for body in ({}, {"lines": [], "extra": 1}, {"lines": [{"nope": 1}]}, {"lines": "x"}):
            with self.subTest(body=body):
                response = self.client.post("/api/materials/check", json.dumps(body), content_type="application/json")
                self.assertEqual(response.status_code, 422)

    def test_check_accepts_empty_lines(self):
        response = self.client.post("/api/materials/check", json.dumps({"lines": []}), content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["summary"]["checked"], 0)
