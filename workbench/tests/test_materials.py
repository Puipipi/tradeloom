from __future__ import annotations

import json
import unittest
from io import BytesIO

from django.test import TestCase

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


class MaterialsApiTests(TestCase):
    # API 层读数据库；前面的 TransactionTestCase 会 flush 测试库并清掉迁移种子，
    # 所以这里在 setUp 显式保证演示物料存在，不依赖迁移执行顺序。
    def setUp(self):
        from workbench.models import MaterialItem as MaterialItemRow
        for item in material_items():
            MaterialItemRow.objects.get_or_create(
                item_code=item.item_code,
                defaults={
                    "item_name": item.item_name, "item_group": item.item_group,
                    "stock_uom": item.stock_uom, "aliases": list(item.aliases),
                    "disabled": item.disabled, "source": "demo_fixture",
                },
            )

    # API 层读数据库（种子迁移提供演示目录）；解析与规则测试保持零 DB 注入路径。
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

    def test_create_item_and_duplicate_conflict(self):
        body = {"item_code": "MAT-TEST-001", "item_name": "测试物料", "item_group": "测试组",
                "stock_uom": "个", "aliases": ["测试件"]}
        response = self.client.post("/api/materials/items", json.dumps(body), content_type="application/json")
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["item"]["source"], "manual")
        self.assertEqual(response.json()["item"]["aliases"], ["测试件"])
        duplicate = self.client.post("/api/materials/items", json.dumps(body), content_type="application/json")
        self.assertEqual(duplicate.status_code, 409)
        listed = self.client.get("/api/materials/items?q=测试物料").json()
        self.assertEqual(listed["total"], 1)

    def test_create_item_rejects_bad_payloads(self):
        bad_bodies = [
            {},
            {"item_name": "x", "item_group": "g", "stock_uom": "u"},
            {"item_code": "bad code!", "item_name": "x", "item_group": "g", "stock_uom": "u"},
            {"item_code": "MAT-OK-1", "item_group": "g", "stock_uom": "u"},
            {"item_code": "MAT-OK-2", "item_name": "", "item_group": "g", "stock_uom": "u"},
            {"item_code": "MAT-OK-3", "item_name": "x", "item_group": "g", "stock_uom": "u", "aliases": ["a", "a"]},
            {"item_code": "MAT-OK-4", "item_name": "x", "item_group": "g", "stock_uom": "u", "aliases": "x"},
            {"item_code": "MAT-OK-5", "item_name": "x", "item_group": "g", "stock_uom": "u", "extra": 1},
        ]
        for body in bad_bodies:
            with self.subTest(body=body):
                response = self.client.post("/api/materials/items", json.dumps(body), content_type="application/json")
                self.assertEqual(response.status_code, 422)

    def test_update_item_disable_and_aliases(self):
        create = self.client.post("/api/materials/items", json.dumps(
            {"item_code": "MAT-UPD-001", "item_name": "旧名", "item_group": "组", "stock_uom": "个"}),
            content_type="application/json")
        self.assertEqual(create.status_code, 201)
        update = self.client.post("/api/materials/items/MAT-UPD-001/update", json.dumps(
            {"item_name": "新名", "disabled": True, "aliases": ["别名甲"]}),
            content_type="application/json")
        self.assertEqual(update.status_code, 200)
        payload = update.json()["item"]
        self.assertEqual(payload["item_name"], "新名")
        self.assertTrue(payload["disabled"])
        self.assertEqual(payload["aliases"], ["别名甲"])
        from workbench.models import MaterialItem as MaterialItemRow
        row = MaterialItemRow.objects.get(item_code="MAT-UPD-001")
        disabled = resolve_reference("别名甲", items=(
            MaterialItem(item_code=row.item_code, item_name=row.item_name, item_group=row.item_group,
                         stock_uom=row.stock_uom, aliases=tuple(row.aliases or ()), disabled=row.disabled),))
        self.assertEqual(disabled.status, "resolved")
        self.assertTrue(disabled.item.disabled)

    def test_update_missing_item_is_404(self):
        response = self.client.post("/api/materials/items/MAT-NONE-999/update", json.dumps(
            {"disabled": True}), content_type="application/json")
        self.assertEqual(response.status_code, 404)

    def test_update_rejects_unknown_and_empty_bodies(self):
        for path, body in (("/api/materials/items/MAT-LED-001/update", {"nope": 1}),
                           ("/api/materials/items/MAT-LED-001/update", {}),
                           ("/api/materials/items/MAT-LED-001/update", {"disabled": "yes"})):
            with self.subTest(body=body):
                response = self.client.post(path, json.dumps(body), content_type="application/json")
                self.assertEqual(response.status_code, 422)


class MaterialIntakeApplyTests(TestCase):
    """material_master 打表候选 → apply 落库为物料主数据。"""

    def setUp(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory

        from django.core.files.uploadedfile import SimpleUploadedFile
        from django.test import override_settings
        from openpyxl import Workbook

        from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT

        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        data_root = Path(self.temp.name) / "data"
        intake_root = data_root / "private" / "intake"
        intake_root.mkdir(parents=True)
        (intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        override = override_settings(TRADELOOM_DATA_ROOT=data_root, TRADELOOM_INTAKE_ROOT=intake_root)
        override.enable()
        self.addCleanup(override.disable)

        workbook = Workbook()
        sheet = workbook.active
        sheet["A1"] = "MAT-IMP-001"
        sheet["A2"] = "导入物料"
        sheet["A3"] = "导入组"
        sheet["A4"] = "个"
        buffer = BytesIO()
        workbook.save(buffer)
        workbook.close()
        upload = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile("materials.xlsx", buffer.getvalue(), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY="material-source-1",
        )
        self.assertEqual(upload.status_code, 201, upload.content)
        source = upload.json()["source"]
        preview = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="material-preview-1",
        ).json()["preview"]
        mapping_body = {
            "schema_version": 1,
            "candidate_type": "material_master",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                "item_code": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
                "item_name": {"cells": [{"sheet_index": 1, "coordinate": "A2"}]},
                "item_group": {"cells": [{"sheet_index": 1, "coordinate": "A3"}]},
                "stock_uom": {"cells": [{"sheet_index": 1, "coordinate": "A4"}]},
            },
        }
        mapping = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings", data=json.dumps(mapping_body),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-mapping-1",
        )
        self.assertEqual(mapping.status_code, 201, mapping.content)
        candidate = self.client.post(
            f"/api/intake/mappings/{mapping.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-candidate-1",
        )
        self.assertEqual(candidate.status_code, 201, candidate.content)
        self.candidate_id = candidate.json()["candidate"]["id"]

    def test_apply_creates_item_with_intake_source(self):
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-1",
        )
        self.assertEqual(response.status_code, 201, response.content)
        payload = response.json()
        self.assertTrue(payload["applied"])
        self.assertEqual(payload["item"]["item_code"], "MAT-IMP-001")
        self.assertTrue(payload["item"]["source"].startswith("intake:"))

    def test_apply_replay_and_identical_reapply_are_success_without_changes(self):
        first = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-1",
        )
        self.assertEqual(first.status_code, 201)
        replay = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-1",
        )
        self.assertEqual(replay.status_code, 200)
        self.assertFalse(replay.json()["applied"])
        reapply = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-2",
        )
        self.assertEqual(reapply.status_code, 200)
        self.assertFalse(reapply.json()["applied"])

    def test_apply_conflicts_when_existing_item_differs(self):
        self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-1",
        )
        from workbench.models import MaterialItem as MaterialItemRow
        MaterialItemRow.objects.filter(item_code="MAT-IMP-001").update(item_name="人工改过的名字")
        conflict = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-3",
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error_code"], "item_exists")

    def test_apply_missing_values_is_rejected(self):
        from django.db import connection

        from workbench.models import IntakeCandidate
        candidate = IntakeCandidate.objects.get(pk=self.candidate_id)
        payload = dict(candidate.typed_payload)
        fields = dict(payload["fields"])
        fields["item_name"] = []
        payload["fields"] = fields
        # IntakeCandidate 是追加记录（QuerySet 禁 update）；测试直接改库构造缺值场景。
        with connection.cursor() as cursor:
            cursor.execute("UPDATE workbench_intakecandidate SET typed_payload = %s WHERE id = %s",
                           [json.dumps(payload), self.candidate_id])
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-4",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "missing_field_values")

    def test_apply_unknown_candidate_is_404(self):
        response = self.client.post(
            "/api/intake/candidates/" + "0" * 32 + "/apply-material", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="material-apply-5",
        )
        self.assertEqual(response.status_code, 404)

    def test_apply_requires_idempotency_key(self):
        response = self.client.post(
            f"/api/intake/candidates/{self.candidate_id}/apply-material", data="{}",
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "invalid_idempotency_key")
