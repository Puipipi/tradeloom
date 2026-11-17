from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import connection
from django.test import TestCase, override_settings
from openpyxl import Workbook

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT


def _xlsx(rows: dict[str, list]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    for column, values in rows.items():
        for index, value in enumerate(values, start=1):
            sheet[f"{column}{index}"] = value
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


class RequirementLineFlowTests(TestCase):
    """生产指令明细行：打表 → apply-lines → 物料核对闸门 → 确认。"""

    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        data_root = Path(self.temp.name) / "data"
        intake_root = data_root / "private" / "intake"
        intake_root.mkdir(parents=True)
        (intake_root / INTAKE_MARKER).write_text(INTAKE_MARKER_CONTENT, encoding="utf-8")
        override = override_settings(TRADELOOM_DATA_ROOT=data_root, TRADELOOM_INTAKE_ROOT=intake_root)
        override.enable()
        self.addCleanup(override.disable)
        # 前面的 TransactionTestCase 会 flush 库并清掉迁移种子；显式保证本测试依赖的物料存在。
        from workbench.models import MaterialItem as MaterialItemRow
        for item in (("MAT-LED-001", "彩灯带"), ("MAT-CTRL-001", "主控制器")):
            MaterialItemRow.objects.get_or_create(item_code=item[0], defaults={
                "item_name": item[1], "item_group": "演示", "stock_uom": "个", "source": "demo_fixture",
            })
        self.requirement_id = self._create_requirement_draft()
        self.lines_candidate_id = self._create_lines_candidate()

    def _upload(self, content: bytes, name: str, key: str) -> dict:
        response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(name, content, "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=key,
        )
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["source"]

    def _post(self, path: str, payload: dict, key: str, expect: int = 201):
        response = self.client.post(path, data=json.dumps(payload), content_type="application/json",
                                    HTTP_IDEMPOTENCY_KEY=key)
        self.assertEqual(response.status_code, expect, response.content)
        return response.json()

    def _create_requirement_draft(self) -> str:
        source = self._upload(_xlsx({
            "A": ["Synthetic requirement description", 10, 4, 2, "unit-x", "pack-x", "Synthetic source requirement"],
            "Z": ["fixture"],
        }), "header.xlsx", "lines-header-source")
        preview = self._post(f"/api/intake/sources/{source['id']}/previews", {}, "lines-header-preview")["preview"]
        mapping = self._post(f"/api/intake/previews/{preview['id']}/mappings", {
            "schema_version": 1,
            "candidate_type": "production_instruction",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                "description": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
                "quantity": {"cells": [{"sheet_index": 1, "coordinate": "A2"}]},
                "unit": {"cells": [{"sheet_index": 1, "coordinate": "A5"}]},
                "carton_count": {"cells": [{"sheet_index": 1, "coordinate": "A4"}]},
                "requirement_text": {"cells": [{"sheet_index": 1, "coordinate": "A7"}]},
                "pack_quantity": {"cells": [{"sheet_index": 1, "coordinate": "A3"}]},
                "pack_unit": {"cells": [{"sheet_index": 1, "coordinate": "A6"}]},
            },
        }, "lines-header-mapping")["mapping"]
        candidate = self._post(f"/api/intake/mappings/{mapping['id']}/candidates", {}, "lines-header-candidate")["candidate"]
        draft = self._post(f"/api/intake/candidates/{candidate['id']}/requirement-drafts",
                           {"record_kind": "new_demand"}, "lines-header-draft")
        return draft["draft"]["id"]

    def _create_lines_candidate(self, *, quantities: list | None = None) -> str:
        source = self._upload(_xlsx({
            "A": ["物料", "彩灯带", "主控制器", "外星材料"],
            "B": ["数量"] + (quantities if quantities is not None else [12, 2, 1]),
            "C": ["单位", "米", "台", "个"],
        }), "lines.xlsx", "lines-detail-source")
        preview = self._post(f"/api/intake/sources/{source['id']}/previews", {}, "lines-detail-preview")["preview"]
        mapping = self._post(f"/api/intake/previews/{preview['id']}/mappings", {
            "schema_version": 1,
            "candidate_type": "production_instruction_line",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                "material": {"cells": [{"sheet_index": 1, "coordinate": "A2"},
                                       {"sheet_index": 1, "coordinate": "A3"},
                                       {"sheet_index": 1, "coordinate": "A4"}]},
                "quantity": {"cells": [{"sheet_index": 1, "coordinate": "B2"},
                                       {"sheet_index": 1, "coordinate": "B3"},
                                       {"sheet_index": 1, "coordinate": "B4"}]},
                "unit": {"cells": [{"sheet_index": 1, "coordinate": "C2"},
                                   {"sheet_index": 1, "coordinate": "C3"},
                                   {"sheet_index": 1, "coordinate": "C4"}]},
            },
        }, "lines-detail-mapping")["mapping"]
        candidate = self._post(f"/api/intake/mappings/{mapping['id']}/candidates", {}, "lines-detail-candidate")["candidate"]
        return candidate["id"]

    def _apply_lines(self, candidate_id: str, requirement_id: str, key: str, expect: int = 201) -> dict:
        return self._post(f"/api/intake/candidates/{candidate_id}/requirement-lines",
                          {"requirement_id": requirement_id}, key, expect=expect)

    def _clear_unresolved_fields(self, requirement_id: str) -> None:
        # 生产要求修订是追加记录；测试直接改库清空字段级未解决状态，聚焦行级闸门。
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE workbench_productionrequirementrevision SET unresolved_fields = '{}'::jsonb "
                "WHERE draft_id = %s AND revision = (SELECT current_revision FROM workbench_productionrequirementdraft WHERE id = %s)",
                [requirement_id, requirement_id],
            )

    def _confirm(self, requirement_id: str, key: str, expect: int):
        response = self.client.post(
            f"/api/production-requirements/{requirement_id}/confirm",
            data=json.dumps({"expected_revision": 1}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        self.assertEqual(response.status_code, expect, response.content)
        return response

    def test_apply_lines_checks_materials_and_blocks_confirmation(self):
        result = self._apply_lines(self.lines_candidate_id, self.requirement_id, "lines-apply-1")
        self.assertTrue(result["applied"])
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["blocked"], 1)
        blocked = [line for line in result["lines"] if line["blocked"]]
        self.assertEqual(blocked[0]["material"], "外星材料")
        self.assertEqual(blocked[0]["issues"][0]["issue_key"], "unknown_item")
        resolved = [line for line in result["lines"] if not line["blocked"]]
        self.assertEqual([line["item_status"] for line in resolved], ["resolved", "resolved"])

        detail = self.client.get(f"/api/production-requirements/{self.requirement_id}").json()
        self.assertEqual(detail["material_lines"]["total"], 3)

        self._clear_unresolved_fields(self.requirement_id)
        self._confirm(self.requirement_id, "lines-confirm-blocked", 409)
        self.assertEqual(
            self._confirm_json_error(self.requirement_id, "lines-confirm-blocked-2"),
            "requirement_lines_blocked",
        )

    def _confirm_json_error(self, requirement_id: str, key: str) -> str:
        response = self.client.post(
            f"/api/production-requirements/{requirement_id}/confirm",
            data=json.dumps({"expected_revision": 1}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=key,
        )
        return response.json().get("error_code", "")

    def test_fixing_master_data_and_reapply_unlocks_confirmation(self):
        self._apply_lines(self.lines_candidate_id, self.requirement_id, "lines-apply-1")
        self.client.post("/api/materials/items", data=json.dumps({
            "item_code": "MAT-ALIEN-001", "item_name": "外星材料", "item_group": "特殊", "stock_uom": "个",
        }), content_type="application/json")
        reapply = self._apply_lines(self.lines_candidate_id, self.requirement_id, "lines-apply-2")
        self.assertEqual(reapply["blocked"], 0)
        self.assertEqual(reapply["total"], 3)
        self._clear_unresolved_fields(self.requirement_id)
        confirmed = self._confirm(self.requirement_id, "lines-confirm-ok", 201)
        self.assertEqual(confirmed.json()["material_lines"]["blocked"], 0)

    def test_apply_lines_replay_is_idempotent(self):
        first = self._apply_lines(self.lines_candidate_id, self.requirement_id, "lines-apply-1")
        replay = self._apply_lines(self.lines_candidate_id, self.requirement_id, "lines-apply-1", expect=200)
        self.assertTrue(first["applied"])
        self.assertFalse(replay["applied"])
        self.assertEqual(replay["total"], first["total"])

    def test_row_shape_mismatch_is_rejected(self):
        source = self._upload(_xlsx({
            "A": ["物料", "彩灯带", "主控制器"],
            "B": ["数量", 1, 2, 3],
            "C": ["单位", "米", "台"],
        }), "lines-bad.xlsx", "lines-bad-source")
        preview = self._post(f"/api/intake/sources/{source['id']}/previews", {}, "lines-bad-preview")["preview"]
        mapping = self._post(f"/api/intake/previews/{preview['id']}/mappings", {
            "schema_version": 1,
            "candidate_type": "production_instruction_line",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                "material": {"cells": [{"sheet_index": 1, "coordinate": "A2"},
                                       {"sheet_index": 1, "coordinate": "A3"}]},
                "quantity": {"cells": [{"sheet_index": 1, "coordinate": "B2"},
                                       {"sheet_index": 1, "coordinate": "B3"},
                                       {"sheet_index": 1, "coordinate": "B4"}]},
                "unit": {"cells": [{"sheet_index": 1, "coordinate": "C2"},
                                   {"sheet_index": 1, "coordinate": "C3"}]},
            },
        }, "lines-bad-mapping")["mapping"]
        candidate = self._post(f"/api/intake/mappings/{mapping['id']}/candidates", {}, "lines-bad-candidate")["candidate"]
        response = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-lines",
            data=json.dumps({"requirement_id": self.requirement_id}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="lines-bad-apply",
        )
        self.assertEqual(response.status_code, 422, response.content)
        self.assertEqual(response.json()["error_code"], "row_shape_mismatch")

    def test_wrong_candidate_type_is_rejected(self):
        material_candidate = self._post(f"/api/intake/candidates/{self.lines_candidate_id}/requirement-lines",
                                        {"requirement_id": self.requirement_id}, "lines-apply-1")
        self.assertEqual(material_candidate["status"], "succeeded")
        # material_master 候选走行端点应被拒。
        source = self._upload(_xlsx({"A": ["MAT-X-1"], "B": ["物料X"], "C": ["组"], "D": ["个"]}),
                              "mm.xlsx", "mm-source")
        preview = self._post(f"/api/intake/sources/{source['id']}/previews", {}, "mm-preview")["preview"]
        mapping = self._post(f"/api/intake/previews/{preview['id']}/mappings", {
            "schema_version": 1,
            "candidate_type": "material_master",
            "source_sha256": source["sha256"],
            "expected_revision": 0,
            "fields": {
                "item_code": {"cells": [{"sheet_index": 1, "coordinate": "A1"}]},
                "item_name": {"cells": [{"sheet_index": 1, "coordinate": "B1"}]},
                "item_group": {"cells": [{"sheet_index": 1, "coordinate": "C1"}]},
                "stock_uom": {"cells": [{"sheet_index": 1, "coordinate": "D1"}]},
            },
        }, "mm-mapping")["mapping"]
        candidate = self._post(f"/api/intake/mappings/{mapping['id']}/candidates", {}, "mm-candidate")["candidate"]
        response = self.client.post(
            f"/api/intake/candidates/{candidate['id']}/requirement-lines",
            data=json.dumps({"requirement_id": self.requirement_id}), content_type="application/json",
            HTTP_IDEMPOTENCY_KEY="mm-as-lines",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "unsupported_candidate_type")
