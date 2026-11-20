from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from openpyxl import Workbook

from workbench.intake.storage import INTAKE_MARKER, INTAKE_MARKER_CONTENT


def _xlsx(columns: dict[str, list]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    for column, values in columns.items():
        for index, value in enumerate(values, start=1):
            sheet[f"{column}{index}"] = value
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()


class DocumentFlowTests(TestCase):
    """采购/入库/出货回款：打表候选 → documents apply → 确认。"""

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
        from workbench.models import MaterialItem
        MaterialItem.objects.get_or_create(item_code="MAT-LED-001", defaults={
            "item_name": "彩灯带", "item_group": "照明", "stock_uom": "米", "source": "demo_fixture"})

    def _upload(self, columns: dict[str, list], name: str, key: str) -> dict:
        response = self.client.post(
            "/api/intake/sources",
            {"file": SimpleUploadedFile(name, _xlsx(columns), "application/octet-stream")},
            HTTP_IDEMPOTENCY_KEY=key,
        )
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["source"]

    def _candidate(self, source: dict, candidate_type: str, fields: dict, mapping_key: str, candidate_key: str) -> str:
        preview = self.client.post(
            f"/api/intake/sources/{source['id']}/previews", data="{}", content_type="application/json",
            HTTP_IDEMPOTENCY_KEY=f"{mapping_key}-preview",
        ).json()["preview"]
        mapping = self.client.post(
            f"/api/intake/previews/{preview['id']}/mappings",
            data=json.dumps({"schema_version": 1, "candidate_type": candidate_type,
                             "source_sha256": source["sha256"], "expected_revision": 0, "fields": fields}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=mapping_key,
        )
        self.assertEqual(mapping.status_code, 201, mapping.content)
        candidate = self.client.post(
            f"/api/intake/mappings/{mapping.json()['mapping']['id']}/candidates", data="{}",
            content_type="application/json", HTTP_IDEMPOTENCY_KEY=candidate_key,
        )
        self.assertEqual(candidate.status_code, 201, candidate.content)
        return candidate.json()["candidate"]["id"]

    @staticmethod
    def _cells(column: str, rows: list[str]) -> list[dict]:
        return [{"sheet_index": 1, "coordinate": f"{column}{index}"} for index in range(2, 2 + len(rows))]

    def test_purchase_plan_flow_with_material_gate(self):
        source = self._upload({"A": ["物料", "彩灯带", "外星材料"], "B": ["数量", 12, 1], "C": ["单位", "米", "个"]},
                              "pp.xlsx", "pp-source")
        candidate = self._candidate(source, "purchase_plan_line", {
            "material": {"cells": self._cells("A", ["a", "b"])},
            "quantity": {"cells": self._cells("B", ["a", "b"])},
            "unit": {"cells": self._cells("C", ["a", "b"])},
        }, "pp-mapping", "pp-candidate")
        from workbench.models import IntakeCandidate, ProductionRequirementDraft
        draft = ProductionRequirementDraft.objects.create(
            record_kind="new_demand", source_candidate=IntakeCandidate.objects.get(pk=candidate))

        response = self.client.post(
            f"/api/intake/candidates/{candidate}/documents",
            data=json.dumps({"doc_type": "purchase_plan", "requirement_id": draft.pk}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="pp-apply-1",
        )
        self.assertEqual(response.status_code, 201, response.content)
        payload = response.json()
        self.assertEqual(payload["total"], 2)
        self.assertEqual(payload["blocked"], 1)

        documents = self.client.get("/api/documents/purchase_plan").json()["documents"]
        blocked = next(doc for doc in documents if doc["blocked"])
        self.assertEqual(blocked["material"], "外星材料")
        ok = next(doc for doc in documents if not doc["blocked"])
        self.assertEqual(ok["item_ref"], {"doctype": "Item", "name": "MAT-LED-001"})

        confirm = self.client.post(f"/api/documents/purchase_plan/{blocked['id']}/confirm",
                                   data="{}", content_type="application/json")
        self.assertEqual(confirm.status_code, 409)
        self.assertEqual(confirm.json()["error_code"], "document_blocked")
        confirm_ok = self.client.post(f"/api/documents/purchase_plan/{ok['id']}/confirm",
                                      data="{}", content_type="application/json")
        self.assertEqual(confirm_ok.status_code, 200)
        self.assertTrue(confirm_ok.json()["document"]["status"] == "confirmed")

    def test_stock_receipt_links_to_purchase_plan(self):
        from workbench.models import PurchasePlan
        plan = PurchasePlan.objects.create(material="彩灯带", quantity="5", unit="米")
        source = self._upload({"A": ["物料", "彩灯带"], "B": ["数量", 5], "C": ["单位", "米"]},
                              "sr.xlsx", "sr-source")
        candidate = self._candidate(source, "stock_receipt_line", {
            "material": {"cells": self._cells("A", ["a"])},
            "quantity": {"cells": self._cells("B", ["a"])},
            "unit": {"cells": self._cells("C", ["a"])},
        }, "sr-mapping", "sr-candidate")
        response = self.client.post(
            f"/api/intake/candidates/{candidate}/documents",
            data=json.dumps({"doc_type": "stock_receipt", "purchase_plan_id": plan.pk}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="sr-apply-1",
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["blocked"], 0)
        documents = self.client.get("/api/documents/stock_receipt").json()["documents"]
        self.assertEqual(documents[0]["purchase_plan_id"], plan.pk)

    def test_shipment_payment_rows_and_confirm(self):
        source = self._upload({"A": ["单号", "SO-1", "SO-2"], "B": ["金额", 1500.5, 2000], "C": ["币种", "USD", "usd"]},
                              "sp.xlsx", "sp-source")
        candidate = self._candidate(source, "shipment_payment_line", {
            "reference": {"cells": self._cells("A", ["a", "b"])},
            "amount": {"cells": self._cells("B", ["a", "b"])},
            "currency": {"cells": self._cells("C", ["a", "b"])},
        }, "sp-mapping", "sp-candidate")
        response = self.client.post(
            f"/api/intake/candidates/{candidate}/documents",
            data=json.dumps({"doc_type": "shipment_payment", "kind": "payment"}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="sp-apply-1",
        )
        self.assertEqual(response.status_code, 201, response.content)
        documents = self.client.get("/api/documents/shipment_payment").json()["documents"]
        self.assertEqual([doc["kind"] for doc in documents], ["payment", "payment"])
        self.assertEqual([doc["currency"] for doc in documents], ["USD", "USD"])
        confirm = self.client.post(f"/api/documents/shipment_payment/{documents[0]['id']}/confirm",
                                   data="{}", content_type="application/json")
        self.assertEqual(confirm.status_code, 200)
        replay = self.client.post(f"/api/documents/shipment_payment/{documents[0]['id']}/confirm",
                                  data="{}", content_type="application/json")
        self.assertEqual(replay.status_code, 200)
        self.assertFalse(replay.json()["confirmed"])

    def test_apply_requires_known_doc_type(self):
        source = self._upload({"A": ["物料", "彩灯带"], "B": ["数量", 1], "C": ["单位", "米"]},
                              "x.xlsx", "x-source")
        candidate = self._candidate(source, "stock_receipt_line", {
            "material": {"cells": self._cells("A", ["a"])},
            "quantity": {"cells": self._cells("B", ["a"])},
            "unit": {"cells": self._cells("C", ["a"])},
        }, "x-mapping", "x-candidate")
        response = self.client.post(
            f"/api/intake/candidates/{candidate}/documents",
            data=json.dumps({"doc_type": "unknown_type"}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="x-apply",
        )
        self.assertEqual(response.status_code, 422)

    def test_purchase_plan_requires_requirement(self):
        source = self._upload({"A": ["物料", "彩灯带"], "B": ["数量", 1], "C": ["单位", "米"]},
                              "y.xlsx", "y-source")
        candidate = self._candidate(source, "purchase_plan_line", {
            "material": {"cells": self._cells("A", ["a"])},
            "quantity": {"cells": self._cells("B", ["a"])},
            "unit": {"cells": self._cells("C", ["a"])},
        }, "y-mapping", "y-candidate")
        response = self.client.post(
            f"/api/intake/candidates/{candidate}/documents",
            data=json.dumps({"doc_type": "purchase_plan"}),
            content_type="application/json", HTTP_IDEMPOTENCY_KEY="y-apply",
        )
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error_code"], "requirement_required")
